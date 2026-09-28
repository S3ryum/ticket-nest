import path from "node:path";

export interface RuntimeConfig {
  token: string;
  clientId: string;
  guildId?: string;
  dataDirectory: string;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const token = env.DISCORD_TOKEN?.trim();
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const guildId = env.DISCORD_GUILD_ID?.trim();

  const missing = [
    !token && "DISCORD_TOKEN",
    !clientId && "DISCORD_CLIENT_ID",
  ].filter((value): value is string => Boolean(value));

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    token: token!,
    clientId: clientId!,
    ...(guildId ? { guildId } : {}),
    dataDirectory: path.resolve(env.TICKET_DATA_DIR?.trim() || "./data"),
  };
}
