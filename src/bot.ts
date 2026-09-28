import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  MessageFlags,
  Interaction,
  ModalBuilder,
  Message,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  PermissionsBitField,
  PermissionOverwrites,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  User,
} from "discord.js";
import {
  canViewTranscript,
  createTicketRecord,
  findCurrentTicket,
  formatTicketNumber,
  TicketActionError,
  transitionTicket,
  type GuildConfig,
  type TicketAction,
  type TicketActor,
  type TicketEventType,
  type TicketRecord,
} from "./domain.js";
import { TicketStore } from "./store.js";
import { panelButton, panelEmbed, ticketControls, ticketEmbed } from "./ui.js";

const REQUIRED_BOT_PERMISSIONS = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];
const MAX_TRANSCRIPT_MESSAGES = 500;
const MAX_TRANSCRIPT_BYTES = 3 * 1024 * 1024;
const ACCESS_PERMISSION_KEYS = [
  ["ViewChannel", PermissionFlagsBits.ViewChannel],
  ["SendMessages", PermissionFlagsBits.SendMessages],
  ["ReadMessageHistory", PermissionFlagsBits.ReadMessageHistory],
  ["AttachFiles", PermissionFlagsBits.AttachFiles],
  ["EmbedLinks", PermissionFlagsBits.EmbedLinks],
] as const;
const openAttempts = new Map<string, number[]>();
const guildLocks = new Map<string, Promise<void>>();

export async function handleInteraction(client: Client, store: TicketStore, interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "ticket") await handleTicketCommand(interaction, client, store);
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction, client, store);
    return;
  }
  if (interaction.isModalSubmit()) await handleTicketModal(interaction, client, store);
}

async function handleTicketCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: TicketStore,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(interaction, "Ticket Nest commands can only be used in a server.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "setup") {
    await setupPanel(interaction, guild, store);
    return;
  }

  if (subcommand === "stats") {
    await showStats(interaction, guild, store);
    return;
  }

  const ticket = store.getTicket(interaction.channelId);
  if (!ticket || ticket.guildId !== guild.id) {
    await replyPrivate(interaction, "Use this command inside a Ticket Nest ticket channel.");
    return;
  }
  const config = store.getGuild(guild.id);
  if (!config) {
    await replyPrivate(interaction, "This server's ticket configuration is missing. Ask an administrator to run `/ticket setup`.");
    return;
  }
  const actor = await resolveActor(guild, interaction.user.id, config);

  switch (subcommand) {
    case "close":
    case "reopen":
    case "archive": {
      const action = subcommand as TicketAction;
      const reason = action === "close" ? interaction.options.getString("reason") ?? undefined : undefined;
      if (action === "archive") {
        await archiveWithTranscript(interaction, guild, store, ticket, config, actor, client);
        return;
      }
      await runTransition(interaction, guild, store, ticket, config, actor, action, reason, client);
      return;
    }
    case "add":
    case "remove": {
      await changeParticipant(
        interaction,
        guild,
        store,
        ticket,
        config,
        actor,
        interaction.options.getUser("member", true),
        subcommand,
        client,
      );
      return;
    }
    case "transcript":
      await sendTranscript(interaction, guild, store, ticket, actor);
      return;
    default:
      await replyPrivate(interaction, "Unknown ticket command.");
  }
}

async function setupPanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: TicketStore,
): Promise<void> {
  const member = await guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await replyPrivate(interaction, "Only members with Manage Server can configure Ticket Nest.");
    return;
  }
  if (!hasAll(interaction.appPermissions, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await replyPrivate(interaction, "I need permission to send messages and embeds in this channel to post the ticket panel.");
    return;
  }
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!hasAll(botMember.permissions, REQUIRED_BOT_PERMISSIONS)) {
    await replyPrivate(interaction, "I need Manage Channels and Manage Roles to create private ticket channels and set their access.");
    return;
  }

  const supportRoleOption = interaction.options.getRole("support_role", true);
  const activeCategory = interaction.options.getChannel("active_category");
  const archiveCategory = interaction.options.getChannel("archive_category");
  const logChannelOption = interaction.options.getChannel("log_channel");
  const supportRole = await guild.roles.fetch(supportRoleOption.id);
  if (!supportRole) {
    await replyPrivate(interaction, "The selected support role is unavailable.");
    return;
  }
  if (supportRole.id === guild.id) {
    await replyPrivate(interaction, "Choose a support role other than @everyone.");
    return;
  }
  if (supportRole.permissions.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Choose a support role without Administrator; Discord administrators can see every server channel.");
    return;
  }
  if (supportRole.position >= botMember.roles.highest.position) {
    await replyPrivate(interaction, "Move the bot's role above the support role before running setup.");
    return;
  }
  if (activeCategory && activeCategory.type !== ChannelType.GuildCategory) {
    await replyPrivate(interaction, "The active category must be a server category.");
    return;
  }
  if (archiveCategory && archiveCategory.type !== ChannelType.GuildCategory) {
    await replyPrivate(interaction, "The archive category must be a server category.");
    return;
  }
  if (activeCategory && archiveCategory && activeCategory.id === archiveCategory.id) {
    await replyPrivate(interaction, "Choose different active and archive categories.");
    return;
  }
  if (logChannelOption && logChannelOption.type !== ChannelType.GuildText) {
    await replyPrivate(interaction, "The log channel must be a regular text channel.");
    return;
  }
  const resolvedLogChannel = logChannelOption
    ? await guild.channels.fetch(logChannelOption.id)
    : null;
  if (logChannelOption && (!resolvedLogChannel || resolvedLogChannel.type !== ChannelType.GuildText)) {
    await replyPrivate(interaction, "The selected log channel is unavailable.");
    return;
  }
  if (resolvedLogChannel?.type === ChannelType.GuildText) {
    const logChannel = resolvedLogChannel;
    if (logChannel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      await replyPrivate(interaction, "The log channel is visible to @everyone. Make it private before using it for transcripts.");
      return;
    }
    if (!logChannel.permissionsFor(supportRole)?.has(PermissionFlagsBits.ViewChannel)) {
      await replyPrivate(interaction, "The selected support role needs View Channel access to the log channel.");
      return;
    }
    const logBotPermissions = logChannel.permissionsFor(botMember);
    if (!logBotPermissions || !hasAll(logBotPermissions, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ])) {
      await replyPrivate(interaction, "I need View Channel, Send Messages, Embed Links, and Attach Files in the selected log channel.");
      return;
    }
  }
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await replyPrivate(interaction, "Run setup in a regular text channel where the ticket panel should appear.");
    return;
  }
  const panelChannel = await guild.channels.fetch(interaction.channel.id);
  if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
    await replyPrivate(interaction, "The panel channel is unavailable.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await runSerial(guild.id, async () => {
      const previous = store.getGuild(guild.id);
      const config: GuildConfig = {
        guildId: guild.id,
        supportRoleId: supportRole.id,
        activeCategoryId: activeCategory?.id ?? null,
        archiveCategoryId: archiveCategory?.id ?? null,
        logChannelId: logChannelOption?.id ?? null,
        panelChannelId: panelChannel.id,
        panelMessageId: previous?.panelMessageId ?? "",
        nextTicketNumber: previous?.nextTicketNumber ?? 1,
        updatedAt: new Date().toISOString(),
      };
      let roleMigrated = false;
      try {
        if (previous && previous.supportRoleId !== config.supportRoleId) {
          await migrateSupportRole(guild, previous.supportRoleId, config.supportRoleId, store);
          roleMigrated = true;
        }
        store.setGuild(config);
        await store.save();
        const panel = await panelChannel.send({
          embeds: [panelEmbed()],
          components: [panelButton()],
          allowedMentions: { parse: [] },
        });
        config.panelChannelId = panel.channelId;
        config.panelMessageId = panel.id;
        await store.save();

        const activeLabel = config.activeCategoryId ? `<#${config.activeCategoryId}>` : "no parent category";
        const archiveLabel = config.archiveCategoryId ? `<#${config.archiveCategoryId}>` : "keep archived channels in place";
        const migrationNote = roleMigrated ? " Existing ticket access was moved to the new role." : "";
        await interaction.editReply(
          `Ticket panel posted in <#${panel.channelId}>. Support: <@&${supportRole.id}> · Active: ${activeLabel} · Archive: ${archiveLabel}.${migrationNote}`,
        );
      } catch (error) {
        if (previous) store.setGuild(previous);
        else delete store.snapshot.guilds[guild.id];
        await store.save().catch(() => undefined);
        if (roleMigrated && previous) {
          await migrateSupportRole(guild, config.supportRoleId, previous.supportRoleId, store).catch(() => undefined);
        }
        throw error;
      }
    });
  } catch (error) {
    await interaction.editReply(`Setup could not be completed. ${safeErrorMessage(error)}`);
  }
}

async function showStats(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: TicketStore,
): Promise<void> {
  const config = store.getGuild(guild.id);
  if (!config) {
    await replyPrivate(interaction, "Run `/ticket setup` first to configure this server.");
    return;
  }
  const actor = await resolveActor(guild, interaction.user.id, config);
  if (!actor.isSupport) {
    await replyPrivate(interaction, "Ticket counts are available to support staff only.");
    return;
  }
  const tickets = Object.values(store.snapshot.tickets).filter((ticket) => ticket.guildId === guild.id);
  const counts = { open: 0, closed: 0, archived: 0 };
  for (const ticket of tickets) counts[ticket.status] += 1;
  await replyPrivate(interaction, `**Ticket totals**\nOpen: ${counts.open} · Closed: ${counts.closed} · Archived: ${counts.archived}`);
}

async function handleButton(interaction: ButtonInteraction, client: Client, store: TicketStore): Promise<void> {
  if (interaction.customId === "ticket:open") {
    const guild = interaction.guild;
    if (!guild || !store.getGuild(guild.id)) {
      await replyPrivate(interaction, "Tickets are not configured in this server yet. Ask an administrator to run `/ticket setup`.");
      return;
    }
    const subject = new TextInputBuilder()
      .setCustomId("subject")
      .setLabel("What do you need help with?")
      .setPlaceholder("A short summary")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true);
    const details = new TextInputBuilder()
      .setCustomId("details")
      .setLabel("Share a few useful details")
      .setPlaceholder("Include steps, context, or what you have already tried.")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1500)
      .setRequired(true);
    const modal = new ModalBuilder()
      .setCustomId("ticket:open-modal")
      .setTitle("Open a support ticket")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(subject),
        new ActionRowBuilder<TextInputBuilder>().addComponents(details),
      );
    await interaction.showModal(modal);
    return;
  }

  const action = interaction.customId.replace("ticket:", "");
  if (action !== "close" && action !== "reopen" && action !== "archive") return;
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(interaction, "Ticket actions can only be used in a server.");
    return;
  }
  const ticket = store.getTicket(interaction.channelId);
  const config = store.getGuild(guild.id);
  if (!ticket || !config || ticket.guildId !== guild.id) {
    await replyPrivate(interaction, "This channel is not a tracked Ticket Nest ticket.");
    return;
  }
  const actor = await resolveActor(guild, interaction.user.id, config);
  if (action === "archive") {
    await archiveWithTranscript(interaction, guild, store, ticket, config, actor, client);
    return;
  }
  await runTransition(interaction, guild, store, ticket, config, actor, action, undefined, client);
}

async function handleTicketModal(
  interaction: ModalSubmitInteraction,
  client: Client,
  store: TicketStore,
): Promise<void> {
  if (interaction.customId !== "ticket:open-modal") return;
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(interaction, "Tickets can only be opened in a server.");
    return;
  }
  const config = store.getGuild(guild.id);
  if (!config) {
    await replyPrivate(interaction, "Run `/ticket setup` first to configure this server.");
    return;
  }

  const subject = interaction.fields.getTextInputValue("subject").trim();
  const details = interaction.fields.getTextInputValue("details").trim();
  if (!subject || !details) {
    await replyPrivate(interaction, "Add a short subject and a few details, then submit the form again.");
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await runSerial(guild.id, async () => {
      const existing = findCurrentTicket(store.snapshot, guild.id, interaction.user.id);
      if (existing) return { kind: "existing" as const, ticket: existing };
      enforceOpenRateLimit(guild.id, interaction.user.id);
      const record = await createTicket(guild, interaction.user, subject, details, config, store, client);
      return { kind: "created" as const, ticket: record };
    });

    if (result.kind === "existing") {
      await interaction.editReply(`You already have a ticket that is not archived: <#${result.ticket.channelId}>.`);
    } else {
      await interaction.editReply(`Your ticket is ready: <#${result.ticket.channelId}>.`);
    }
  } catch (error) {
    await interaction.editReply(safeErrorMessage(error));
  }
}

async function createTicket(
  guild: Guild,
  owner: User,
  subject: string,
  details: string,
  config: GuildConfig,
  store: TicketStore,
  client: Client,
): Promise<TicketRecord> {
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!hasAll(botMember.permissions, REQUIRED_BOT_PERMISSIONS)) {
    throw new TicketActionError("I need Manage Channels and Manage Roles to create a private ticket channel.");
  }
  const supportRole = await guild.roles.fetch(config.supportRoleId);
  if (!supportRole || supportRole.id === guild.id) {
    throw new TicketActionError("The configured support role no longer exists. Ask an administrator to run `/ticket setup` again.");
  }
  if (config.activeCategoryId) {
    const category = await guild.channels.fetch(config.activeCategoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new TicketActionError("The configured active category is unavailable. Ask an administrator to update `/ticket setup`.");
    }
  }

  const ticketNumber = config.nextTicketNumber;
  const channelName = `ticket-${formatTicketNumber(ticketNumber)}-${slug(owner.username)}`.slice(0, 90);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    ...(config.activeCategoryId ? { parent: config.activeCategoryId } : {}),
    topic: `Ticket Nest #${formatTicketNumber(ticketNumber)} · owner ${owner.id}`,
    reason: `Support ticket #${formatTicketNumber(ticketNumber)} opened through Ticket Nest`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: owner.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: supportRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ],
  });

  const ticket = createTicketRecord({
    guildId: guild.id,
    ticketNumber,
    channelId: channel.id,
    ownerId: owner.id,
    ownerName: owner.username,
    subject,
  });
  config.nextTicketNumber += 1;
  store.setTicket(ticket);
  try {
    await store.save();
  } catch (error) {
    delete store.snapshot.tickets[channel.id];
    config.nextTicketNumber = ticketNumber;
    await channel.delete("Ticket state could not be saved").catch(() => undefined);
    throw error;
  }

  const supportMention = `<@&${supportRole.id}>`;
  const control = await channel.send({
    content: `<@${owner.id}> ${supportMention}`,
    embeds: [ticketEmbed(ticket)],
    components: ticketControls(ticket),
    allowedMentions: { users: [owner.id], roles: [supportRole.id] },
  });
  ticket.controlMessageId = control.id;
  store.setTicket(ticket);
  await store.save();
  await channel.send({
    content: `**Request details**\n${details.slice(0, 1500)}`,
    allowedMentions: { parse: [] },
  });
  await postLog(guild, config, ticket, "Ticket opened", `Opened by <@${owner.id}>: **${ticket.subject}**`, client);
  return ticket;
}

async function runTransition(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  store: TicketStore,
  ticket: TicketRecord,
  config: GuildConfig,
  actor: TicketActor,
  action: TicketAction,
  reason: string | undefined,
  client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let next: TicketRecord;
  try {
    next = transitionTicket(ticket, action, actor, new Date(), reason);
  } catch (error) {
    await interaction.editReply(safeErrorMessage(error));
    return;
  }

  const channel = await getTicketChannel(guild, ticket.channelId);
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!hasAll(botMember.permissions, REQUIRED_BOT_PERMISSIONS)) {
    await interaction.editReply("I need Manage Channels and Manage Roles to change ticket access.");
    return;
  }

  store.setTicket(next);
  try {
    await store.save();
    if (action === "close") {
      await channel.permissionOverwrites.edit(ticket.ownerId, {
        ViewChannel: true,
        SendMessages: false,
        ReadMessageHistory: true,
      });
    } else if (action === "reopen") {
      if (ticket.status === "archived" && config.activeCategoryId) {
        await channel.setParent(config.activeCategoryId, { lockPermissions: false });
      }
      await channel.permissionOverwrites.edit(ticket.ownerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    } else {
      await channel.permissionOverwrites.edit(ticket.ownerId, {
        ViewChannel: false,
        SendMessages: false,
      });
      if (config.archiveCategoryId) {
        await channel.setParent(config.archiveCategoryId, { lockPermissions: false });
      }
    }
  } catch (error) {
    store.setTicket(ticket);
    await store.save();
    await restoreChannelAccess(channel, ticket, config).catch(() => undefined);
    await interaction.editReply(`Discord could not update this ticket's channel access, so the ticket state was rolled back. ${safeErrorMessage(error)}`);
    return;
  }

  await refreshControlMessage(channel, next);
  await postLog(guild, config, next, `Ticket ${action}d`, `Action by <@${actor.id}> · ticket #${formatTicketNumber(next.ticketNumber)}`, client);
  await interaction.editReply(`Ticket #${formatTicketNumber(next.ticketNumber)} is now **${next.status}**.`);
}

async function changeParticipant(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: TicketStore,
  ticket: TicketRecord,
  config: GuildConfig,
  actor: TicketActor,
  target: User,
  action: "add" | "remove",
  client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!actor.isSupport) {
    await interaction.editReply("Only support staff can change ticket participants.");
    return;
  }
  if (ticket.status === "archived") {
    await interaction.editReply("Reopen the ticket before changing its participants.");
    return;
  }
  if (target.id === ticket.ownerId) {
    await interaction.editReply("The ticket owner always keeps access while the ticket is open or closed.");
    return;
  }
  const targetMember = await guild.members.fetch(target.id).catch(() => null);
  if (!targetMember) {
    await interaction.editReply("That member is no longer in this server.");
    return;
  }
  if (targetMember.roles.cache.has(config.supportRoleId)) {
    await interaction.editReply("Members of the configured support role already have access to every ticket.");
    return;
  }
  const channel = await getTicketChannel(guild, ticket.channelId);
  const updated: TicketRecord = {
    ...ticket,
    history: [
      ...ticket.history,
      {
        type: action === "add" ? "participant_added" : "participant_removed",
        actorId: actor.id,
        at: new Date().toISOString(),
        detail: target.id,
      },
    ],
  };
  try {
    store.setTicket(updated);
    await store.save();
    if (action === "add") {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        SendMessages: ticket.status === "open",
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      });
    } else {
      await channel.permissionOverwrites.delete(target.id);
    }
  } catch (error) {
    store.setTicket(ticket);
    await store.save().catch(() => undefined);
    await restoreParticipantAccess(channel, target.id, ticket, action).catch(() => undefined);
    await interaction.editReply(`Discord could not update this participant. ${safeErrorMessage(error)}`);
    return;
  }
  await postLog(
    guild,
    config,
    updated,
    action === "add" ? "Participant added" : "Participant removed",
    `<@${target.id}> · action by <@${actor.id}>`,
    client,
  );
  await interaction.editReply(action === "add" ? `Added <@${target.id}> to this ticket.` : `Removed <@${target.id}> from this ticket.`);
}

async function sendTranscript(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  store: TicketStore,
  ticket: TicketRecord,
  actor: TicketActor,
): Promise<void> {
  if (!canViewTranscript(ticket, actor)) {
    await replyPrivate(interaction, "Only the ticket owner and support staff can download its transcript.");
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const channel = await getTicketChannel(guild, ticket.channelId);
    const { body, truncated } = await buildTranscript(channel, ticket);
    const filename = `ticket-${formatTicketNumber(ticket.ticketNumber)}.txt`;
    await interaction.editReply({
      content: truncated ? "Transcript attached. The export is capped to the most recent messages." : "Transcript attached.",
      files: [new AttachmentBuilder(Buffer.from(body, "utf8"), { name: filename })],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.editReply(`Could not create the transcript. ${safeErrorMessage(error)}`);
  }
}

async function buildTranscript(channel: TextChannel, ticket: TicketRecord): Promise<{ body: string; truncated: boolean }> {
  const messages: Message[] = [];
  let before: string | undefined;
  let truncated = false;

  while (messages.length < MAX_TRANSCRIPT_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  if (messages.length >= MAX_TRANSCRIPT_MESSAGES && before) truncated = true;
  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);

  const lines = [
    `Ticket Nest transcript #${formatTicketNumber(ticket.ticketNumber)}`,
    `Subject: ${ticket.subject}`,
    `Owner: ${ticket.ownerName} (${ticket.ownerId})`,
    `Status: ${ticket.status}`,
    `Created: ${ticket.createdAt}`,
    "",
  ];
  let bytes = Buffer.byteLength(lines.join("\n"), "utf8");
  for (const message of messages) {
    const content = message.content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    const attachmentLines = [...message.attachments.values()].map((attachment) => `  Attachment: ${attachment.name} — ${attachment.url}`);
    const block = `${new Date(message.createdTimestamp).toISOString()} | ${message.author.tag}: ${content || "[no plain-text content]"}\n${attachmentLines.join("\n")}`.trimEnd();
    const blockBytes = Buffer.byteLength(block, "utf8") + 1;
    if (bytes + blockBytes > MAX_TRANSCRIPT_BYTES) {
      truncated = true;
      break;
    }
    lines.push(block, "");
    bytes += blockBytes;
  }
  if (truncated) lines.push("[Transcript truncated to fit the export limit.]");
  return { body: lines.join("\n"), truncated };
}

async function postLog(
  guild: Guild,
  config: GuildConfig,
  ticket: TicketRecord,
  title: string,
  description: string,
  client: Client,
  transcript?: AttachmentBuilder,
): Promise<boolean> {
  if (!config.logChannelId) return false;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const embed = new EmbedBuilder()
    .setColor(ticket.status === "archived" ? 0x99aab5 : 0x5865f2)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: "Ticket", value: `#${formatTicketNumber(ticket.ticketNumber)} · <#${ticket.channelId}>`, inline: true },
      { name: "Owner", value: `<@${ticket.ownerId}>`, inline: true },
    )
    .setTimestamp();
  try {
    await channel.send({
    embeds: [embed],
    ...(transcript ? { files: [transcript] } : {}),
    allowedMentions: { parse: [] },
    });
    return true;
  } catch {
    return false;
  }
}

async function archiveWithTranscript(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  store: TicketStore,
  ticket: TicketRecord,
  config: GuildConfig,
  actor: TicketActor,
  client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!actor.isSupport) {
    await interaction.editReply("Only support staff can archive tickets.");
    return;
  }
  let next: TicketRecord;
  try {
    next = transitionTicket(ticket, "archive", actor);
  } catch (error) {
    await interaction.editReply(safeErrorMessage(error));
    return;
  }
  const channel = await getTicketChannel(guild, ticket.channelId);
  const { body } = await buildTranscript(channel, ticket);
  const transcript = new AttachmentBuilder(Buffer.from(body, "utf8"), {
    name: `ticket-${formatTicketNumber(ticket.ticketNumber)}.txt`,
  });
  store.setTicket(next);
  try {
    await store.save();
    await channel.permissionOverwrites.edit(ticket.ownerId, { ViewChannel: false, SendMessages: false });
    if (config.archiveCategoryId) await channel.setParent(config.archiveCategoryId, { lockPermissions: false });
  } catch (error) {
    store.setTicket(ticket);
    await store.save();
    await restoreChannelAccess(channel, ticket, config).catch(() => undefined);
    await interaction.editReply(`Discord could not archive this ticket, so its state was rolled back. ${safeErrorMessage(error)}`);
    return;
  }
  await refreshControlMessage(channel, next);
  const logged = await postLog(guild, config, next, "Ticket archived", `Archived by <@${actor.id}> · ticket #${formatTicketNumber(next.ticketNumber)}`, client, transcript);
  const note = logged
    ? "The transcript was sent to the configured log channel."
    : config.logChannelId
      ? "The archive is complete, but I could not send the transcript to the log channel. Staff can still use `/ticket transcript` here."
      : "No log channel is configured. Staff can still use `/ticket transcript` here.";
  await interaction.editReply(`Ticket #${formatTicketNumber(next.ticketNumber)} is archived. ${note}`);
}

async function refreshControlMessage(channel: TextChannel, ticket: TicketRecord): Promise<void> {
  if (!ticket.controlMessageId) return;
  const message = await channel.messages.fetch(ticket.controlMessageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [ticketEmbed(ticket)], components: ticketControls(ticket) }).catch(() => undefined);
}

async function restoreChannelAccess(channel: TextChannel, previous: TicketRecord, config: GuildConfig): Promise<void> {
  if (previous.status === "archived") {
    await channel.permissionOverwrites.edit(previous.ownerId, { ViewChannel: false, SendMessages: false });
    if (config.archiveCategoryId && channel.parentId !== config.archiveCategoryId) {
      await channel.setParent(config.archiveCategoryId, { lockPermissions: false });
    }
  } else if (previous.status === "closed") {
    await channel.permissionOverwrites.edit(previous.ownerId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true });
  } else {
    await channel.permissionOverwrites.edit(previous.ownerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  }
}

async function restoreParticipantAccess(
  channel: TextChannel,
  participantId: string,
  ticket: TicketRecord,
  action: "add" | "remove",
): Promise<void> {
  if (action === "add") {
    await channel.permissionOverwrites.delete(participantId);
  } else {
    await channel.permissionOverwrites.edit(participantId, {
      ViewChannel: true,
      SendMessages: ticket.status === "open",
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });
  }
}

type AccessPermissionPatch = {
  ViewChannel: boolean | null;
  SendMessages: boolean | null;
  ReadMessageHistory: boolean | null;
  AttachFiles: boolean | null;
  EmbedLinks: boolean | null;
};

function captureAccessPermissions(overwrite: PermissionOverwrites | undefined): AccessPermissionPatch {
  const patch = {} as AccessPermissionPatch;
  for (const [key, flag] of ACCESS_PERMISSION_KEYS) {
    patch[key] = overwrite?.allow.has(flag) ? true : overwrite?.deny.has(flag) ? false : null;
  }
  return patch;
}

async function restoreAccessOverwrite(channel: TextChannel, roleId: string, patch: AccessPermissionPatch): Promise<void> {
  if (Object.values(patch).every((value) => value === null)) {
    await channel.permissionOverwrites.delete(roleId).catch(() => undefined);
    return;
  }
  await channel.permissionOverwrites.edit(roleId, patch);
}

async function migrateSupportRole(
  guild: Guild,
  oldRoleId: string,
  newRoleId: string,
  store: TicketStore,
): Promise<void> {
  if (oldRoleId === newRoleId) return;
  const changed: Array<{
    channel: TextChannel;
    previousOld: AccessPermissionPatch;
    previousNew: AccessPermissionPatch;
    hadOld: boolean;
    hadNew: boolean;
  }> = [];

  try {
    const tickets = Object.values(store.snapshot.tickets).filter((ticket) => ticket.guildId === guild.id);
    for (const ticket of tickets) {
      const fetched = await guild.channels.fetch(ticket.channelId);
      if (!fetched || fetched.type !== ChannelType.GuildText) continue;
      const oldOverwrite = fetched.permissionOverwrites.cache.get(oldRoleId);
      const newOverwrite = fetched.permissionOverwrites.cache.get(newRoleId);
      const previous = {
        channel: fetched,
        previousOld: captureAccessPermissions(oldOverwrite),
        previousNew: captureAccessPermissions(newOverwrite),
        hadOld: Boolean(oldOverwrite),
        hadNew: Boolean(newOverwrite),
      };
      changed.push(previous);
      await fetched.permissionOverwrites.edit(newRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      });
      if (oldOverwrite) await fetched.permissionOverwrites.delete(oldRoleId);
    }
  } catch (error) {
    for (const previous of changed.reverse()) {
      if (previous.hadOld) {
        await previous.channel.permissionOverwrites.edit(oldRoleId, previous.previousOld).catch(() => undefined);
      }
      if (previous.hadNew) {
        await previous.channel.permissionOverwrites.edit(newRoleId, previous.previousNew).catch(() => undefined);
      } else {
        await previous.channel.permissionOverwrites.delete(newRoleId).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function getTicketChannel(guild: Guild, channelId: string): Promise<TextChannel> {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new TicketActionError("The ticket channel no longer exists or is not a text channel.");
  }
  return channel;
}

async function resolveActor(guild: Guild, userId: string, config: GuildConfig): Promise<TicketActor> {
  const member = await guild.members.fetch(userId);
  return { id: userId, isSupport: isSupport(member, config) };
}

function isSupport(member: GuildMember, config: GuildConfig): boolean {
  return member.roles.cache.has(config.supportRoleId) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function enforceOpenRateLimit(guildId: string, userId: string): void {
  const now = Date.now();
  for (const [entryKey, timestamps] of openAttempts) {
    if (timestamps.every((timestamp) => now - timestamp >= 10 * 60_000)) openAttempts.delete(entryKey);
  }
  const key = `${guildId}:${userId}`;
  const recent = (openAttempts.get(key) ?? []).filter((timestamp) => now - timestamp < 10 * 60_000);
  if (recent.length >= 3 || (recent.length > 0 && now - recent[recent.length - 1]! < 15_000)) {
    throw new TicketActionError("Please wait a little before opening another ticket.");
  }
  recent.push(now);
  openAttempts.set(key, recent);
}

async function runSerial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = guildLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  guildLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (guildLocks.get(key) === current) guildLocks.delete(key);
  }
}

function hasAll(permissions: Readonly<PermissionsBitField>, required: bigint[]): boolean {
  return permissions.has(required);
}

function slug(value: string): string {
  const result = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return result || "member";
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  const payload = { content, flags: MessageFlags.Ephemeral as const };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof TicketActionError) return error.message;
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, " ").slice(0, 220);
    return `The operation did not finish (${message}). Check the bot's channel permissions and try again.`;
  }
  return "The operation did not finish. Check the bot's channel permissions and try again.";
}

// Keep the imported type visible in generated declarations without exposing a server-specific value.
export type { TicketEventType };
