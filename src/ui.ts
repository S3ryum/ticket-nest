import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatTicketNumber, type TicketRecord } from "./domain.js";

export function panelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Need a hand?")
    .setDescription("Open a private support ticket. Share one request per ticket and a support team member will follow up here.")
    .setFooter({ text: "Ticket Nest • Your request stays visible to you and the support team." });
}
export function panelButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket:open").setLabel("Open a ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary),
  );
}

export function ticketEmbed(ticket: TicketRecord): EmbedBuilder {
  const color = ticket.status === "open" ? 0x57f287 : ticket.status === "closed" ? 0xfee75c : 0x99aab5;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Ticket #${formatTicketNumber(ticket.ticketNumber)} · ${ticket.status}`)
    .setDescription(`**Subject**\n${ticket.subject}\n\n**Opened by**\n<@${ticket.ownerId}>`)
    .addFields({ name: "Opened", value: `<t:${Math.floor(Date.parse(ticket.createdAt) / 1000)}:f>`, inline: true })
    .setFooter({ text: "Ticket Nest" });

  if (ticket.closeReason) embed.addFields({ name: "Close note", value: ticket.closeReason.slice(0, 300) });
  return embed;
}

export function ticketControls(ticket: TicketRecord): ActionRowBuilder<ButtonBuilder>[] {
  if (ticket.status === "open") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket:close").setLabel("Close ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    )];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket:reopen").setLabel("Reopen").setEmoji("🔓").setStyle(ButtonStyle.Success),
  );
  if (ticket.status === "closed") {
    row.addComponents(
      new ButtonBuilder().setCustomId("ticket:archive").setLabel("Archive").setEmoji("📦").setStyle(ButtonStyle.Secondary),
    );
  }
  return [row];
}
