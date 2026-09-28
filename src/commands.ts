import { ChannelType, SlashCommandBuilder } from "discord.js";

export const ticketCommand = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Create and manage private support tickets")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription("Configure support roles and ticket categories, then post a ticket panel")
      .addRoleOption((option) =>
        option.setName("support_role").setDescription("Role that can view and manage tickets").setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("active_category")
          .setDescription("Optional category for new tickets")
          .addChannelTypes(ChannelType.GuildCategory),
      )
      .addChannelOption((option) =>
        option
          .setName("archive_category")
          .setDescription("Optional category for archived tickets")
          .addChannelTypes(ChannelType.GuildCategory),
      )
      .addChannelOption((option) =>
        option
          .setName("log_channel")
          .setDescription("Optional private channel for ticket event logs and transcripts")
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((subcommand) => subcommand.setName("close").setDescription("Close this ticket").addStringOption((option) =>
    option.setName("reason").setDescription("Optional note for the audit log").setMaxLength(300),
  ))
  .addSubcommand((subcommand) => subcommand.setName("reopen").setDescription("Reopen this ticket"))
  .addSubcommand((subcommand) => subcommand.setName("archive").setDescription("Archive a closed ticket (support staff only)"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Give another member access to this ticket (support staff only)")
      .addUserOption((option) => option.setName("member").setDescription("Member to add").setRequired(true)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a participant from this ticket (support staff only)")
      .addUserOption((option) => option.setName("member").setDescription("Member to remove").setRequired(true)),
  )
  .addSubcommand((subcommand) => subcommand.setName("transcript").setDescription("Download a private text transcript"))
  .addSubcommand((subcommand) => subcommand.setName("stats").setDescription("Show this server's ticket counts (support staff only)"));

export const commandData = [ticketCommand.toJSON()];
