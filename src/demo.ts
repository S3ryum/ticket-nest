import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTicketRecord, TicketActionError, transitionTicket } from "./domain.js";
import { TicketStore } from "./store.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-nest-demo-"));

try {
  const store = await TicketStore.open(directory);
  let ticket = createTicketRecord({
    guildId: "demo-guild",
    ticketNumber: 1,
    channelId: "demo-channel",
    ownerId: "demo-owner",
    ownerName: "Alex",
    subject: "Cannot access my account",
    now: new Date("2026-01-01T10:00:00.000Z"),
  });
  store.setTicket(ticket);
  await store.save();

  ticket = transitionTicket(ticket, "close", { id: "demo-owner", isSupport: false }, new Date("2026-01-01T10:10:00.000Z"));
  store.setTicket(ticket);
  await store.save();
  ticket = transitionTicket(ticket, "reopen", { id: "demo-owner", isSupport: false }, new Date("2026-01-01T10:15:00.000Z"));
  store.setTicket(ticket);
  await store.save();
  ticket = transitionTicket(ticket, "close", { id: "demo-staff", isSupport: true }, new Date("2026-01-01T11:00:00.000Z"), "Resolved");
  store.setTicket(ticket);
  await store.save();
  ticket = transitionTicket(ticket, "archive", { id: "demo-staff", isSupport: true }, new Date("2026-01-01T11:02:00.000Z"));
  store.setTicket(ticket);
  await store.save();

  const reloaded = await TicketStore.open(directory);
  const persisted = reloaded.getTicket("demo-channel");
  if (!persisted || persisted.status !== "archived" || persisted.history.length !== 5) {
    throw new Error("The persisted ticket lifecycle did not match the expected final state.");
  }

  let blocked = false;
  try {
    transitionTicket(persisted, "reopen", { id: "demo-owner", isSupport: false });
  } catch (error) {
    blocked = error instanceof TicketActionError;
  }
  if (!blocked) throw new Error("An archived ticket should require support staff to reopen.");

  console.log("Offline ticket lifecycle verified: open → closed → reopened → closed → archived.");
  console.log("Persistence verified after reopening the JSON store; archived-ticket permissions are enforced.");
} finally {
  const demoPrefix = path.join(os.tmpdir(), "ticket-nest-demo-");
  if (!directory.startsWith(demoPrefix)) throw new Error("Refusing to clean an unexpected demo path.");
  await rm(directory, { recursive: true, force: true });
}
