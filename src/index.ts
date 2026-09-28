import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { readRuntimeConfig } from "./config.js";
import { handleInteraction } from "./bot.js";
import { TicketStore } from "./store.js";

const config = readRuntimeConfig();
const store = await TicketStore.open(config.dataDirectory);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ticket Nest is ready as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(client, store, interaction);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 220) : "Unknown interaction error";
    console.error(`[interaction] ${message}`);
    if (!interaction.isRepliable()) return;
    const response = "Something went wrong while handling that action. Please try again or contact support.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: response, flags: MessageFlags.Ephemeral as const }).catch(() => undefined);
    } else {
      await interaction.reply({ content: response, flags: MessageFlags.Ephemeral as const }).catch(() => undefined);
    }
  }
});

client.on(Events.Error, (error) => {
  console.error(`[discord] ${error.message.replace(/\s+/g, " ").slice(0, 220)}`);
});

await client.login(config.token);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    client.destroy();
    process.exit(0);
  });
}
