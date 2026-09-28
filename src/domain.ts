export type TicketStatus = "open" | "closed" | "archived";

export type TicketEventType =
  | "created"
  | "closed"
  | "reopened"
  | "archived"
  | "participant_added"
  | "participant_removed";

export interface TicketEvent {
  type: TicketEventType;
  actorId: string;
  at: string;
  detail?: string;
}

export interface TicketRecord {
  guildId: string;
  ticketNumber: number;
  channelId: string;
  controlMessageId?: string;
  ownerId: string;
  ownerName: string;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  closedAt?: string;
  archivedAt?: string;
  closeReason?: string;
  history: TicketEvent[];
}

export interface GuildConfig {
  guildId: string;
  supportRoleId: string;
  activeCategoryId: string | null;
  archiveCategoryId: string | null;
  logChannelId: string | null;
  panelChannelId: string;
  panelMessageId: string;
  nextTicketNumber: number;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 1;
  guilds: Record<string, GuildConfig>;
  tickets: Record<string, TicketRecord>;
}

export type TicketAction = "close" | "reopen" | "archive";

export interface TicketActor {
  id: string;
  isSupport: boolean;
}

export class TicketActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketActionError";
  }
}

export function transitionTicket(
  ticket: TicketRecord,
  action: TicketAction,
  actor: TicketActor,
  now: Date = new Date(),
  reason?: string,
): TicketRecord {
  const at = now.toISOString();

  switch (action) {
    case "close": {
      if (ticket.status !== "open") {
        throw new TicketActionError("Only an open ticket can be closed.");
      }
      if (actor.id !== ticket.ownerId && !actor.isSupport) {
        throw new TicketActionError("Only the ticket owner or support staff can close it.");
      }
      const closeReason = reason?.trim().slice(0, 300);
      return {
        ...ticket,
        status: "closed",
        closedAt: at,
        ...(closeReason ? { closeReason } : {}),
        history: [...ticket.history, { type: "closed", actorId: actor.id, at, ...(closeReason ? { detail: closeReason } : {}) }],
      };
    }
    case "reopen": {
      if (ticket.status === "open") {
        throw new TicketActionError("This ticket is already open.");
      }
      if (ticket.status === "archived" && !actor.isSupport) {
        throw new TicketActionError("Only support staff can reopen an archived ticket.");
      }
      if (actor.id !== ticket.ownerId && !actor.isSupport) {
        throw new TicketActionError("Only the ticket owner or support staff can reopen it.");
      }
      const { closedAt: _closedAt, archivedAt: _archivedAt, closeReason: _closeReason, ...reopened } = ticket;
      return {
        ...reopened,
        status: "open",
        history: [...ticket.history, { type: "reopened", actorId: actor.id, at }],
      };
    }
    case "archive": {
      if (ticket.status !== "closed") {
        throw new TicketActionError("Close the ticket before archiving it.");
      }
      if (!actor.isSupport) {
        throw new TicketActionError("Only support staff can archive tickets.");
      }
      return {
        ...ticket,
        status: "archived",
        archivedAt: at,
        history: [...ticket.history, { type: "archived", actorId: actor.id, at }],
      };
    }
  }
}

export function canViewTranscript(ticket: TicketRecord, actor: TicketActor): boolean {
  return actor.id === ticket.ownerId || actor.isSupport;
}

export function findCurrentTicket(
  state: PersistedState,
  guildId: string,
  ownerId: string,
): TicketRecord | undefined {
  return Object.values(state.tickets).find(
    (ticket) => ticket.guildId === guildId && ticket.ownerId === ownerId && ticket.status !== "archived",
  );
}

export function createTicketRecord(input: {
  guildId: string;
  ticketNumber: number;
  channelId: string;
  ownerId: string;
  ownerName: string;
  subject: string;
  now?: Date;
}): TicketRecord {
  const at = (input.now ?? new Date()).toISOString();
  return {
    guildId: input.guildId,
    ticketNumber: input.ticketNumber,
    channelId: input.channelId,
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    subject: input.subject.trim().slice(0, 100),
    status: "open",
    createdAt: at,
    history: [{ type: "created", actorId: input.ownerId, at }],
  };
}

export function formatTicketNumber(ticketNumber: number): string {
  return String(ticketNumber).padStart(4, "0");
}
