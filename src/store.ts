import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuildConfig, PersistedState, TicketRecord } from "./domain.js";

function emptyState(): PersistedState {
  return { schemaVersion: 1, guilds: {}, tickets: {} };
}

export class TicketStore {
  private state: PersistedState;
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    initialState: PersistedState,
  ) {
    this.state = initialState;
  }

  static async open(directory: string): Promise<TicketStore> {
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "state.json");
    let initial = emptyState();

    try {
      const contents = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (!isPersistedState(parsed)) {
        throw new Error("Stored ticket data has an unsupported or invalid format.");
      }
      initial = parsed;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    return new TicketStore(filePath, initial);
  }

  get snapshot(): PersistedState {
    return this.state;
  }

  getGuild(guildId: string): GuildConfig | undefined {
    return this.state.guilds[guildId];
  }

  setGuild(config: GuildConfig): void {
    this.state.guilds[config.guildId] = config;
  }

  getTicket(channelId: string): TicketRecord | undefined {
    return this.state.tickets[channelId];
  }

  setTicket(ticket: TicketRecord): void {
    this.state.tickets[ticket.channelId] = ticket;
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2) + "\n";
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const nextWrite = this.pendingWrite.catch(() => undefined).then(async () => {
      await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
      await rename(tempPath, this.filePath);
    });
    this.pendingWrite = nextWrite;
    await nextWrite;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && isRecord(record.guilds) && isRecord(record.tickets);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
