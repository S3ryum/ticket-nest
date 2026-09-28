import { REST, Routes } from "discord.js";
import { commandData } from "./commands.js";
import { readRuntimeConfig } from "./config.js";

const config = readRuntimeConfig();
const rest = new REST({ version: "10" }).setToken(config.token);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commandData });
console.log(config.guildId ? "Ticket Nest commands registered for the development server." : "Ticket Nest commands registered globally.");
