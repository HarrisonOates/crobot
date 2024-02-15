import {
  areItemsEqual,
  BASEROW_ITEM_FIELDS,
  BaserowGetRowsResponse,
  BaserowItem,
  BaserowWebhook,
} from "./baserow-types";
import express, { Express, Request } from "express";
import { Guild, GuildMember } from "discord.js";

const baserowData: Map<number, BaserowItem> = new Map();
const MEMBER_ROLE_ID = "753524901708693558";
const LIFE_MEMBER_ROLE_ID = "702889882598506558";
const CSSA_SERVER_ID = process.env.CSSA_SERVER || "";

function transformUsername(username: string): string;
function transformUsername(username: string | null): string | undefined;
function transformUsername(username: string | null): string | undefined {
  if (username === null) return undefined;
  // New discord names are stored lowercase, and case insensitive
  if (!username.includes("#")) {
    username = username.toLowerCase();
    return username;
  }
}

const isLifeMember = (item: BaserowItem): boolean => {
  return item[BASEROW_ITEM_FIELDS.FLAGS].some(
    (flag) => flag.value === "Life Member",
  );
};

export async function refreshBaserowData() {
  // Fetch data from baserow
  // Store in baserowData
  // Fire events for onRowCreate, onRowUpdate, onRowDelete as necessary
  const fetchedData: BaserowItem[] = [];
  let nextUrl: string | null =
    "https://baserow.cssa.club/api/database/rows/table/511/?size=200";
  while (nextUrl) {
    // eslint-disable-next-line no-await-in-loop
    const baserowPage: BaserowGetRowsResponse = await fetch(nextUrl).then(
      (response) => response.json(),
    );
    fetchedData.push(...baserowPage.results);
    nextUrl = baserowPage.next;
  }
  const deletedRowIds = new Set(baserowData.keys());
  const eventPromises: Promise<unknown>[] = [];
  for (const row of fetchedData) {
    const existingItem = baserowData.get(row.id);
    if (existingItem) {
      if (!areItemsEqual(existingItem, row)) {
        eventPromises.push(onRowUpdate(row, existingItem));
        baserowData.set(row.id, row);
      }
      deletedRowIds.delete(row.id);
    } else {
      eventPromises.push(onRowCreate(row));
      baserowData.set(row.id, row);
    }
  }
  for (const id of deletedRowIds) {
    const existingItem = baserowData.get(id);
    if (existingItem) {
      eventPromises.push(onRowDelete(existingItem));
    } else {
      console.warn("Deleted item not found in baserowData");
    }
    baserowData.delete(id);
  }

  // Drop any members not in the fetched data
  const cssaGuild = await discordClient.guilds.fetch(CSSA_SERVER_ID);
  if (!cssaGuild) throw new Error("Couldn't fetch CSSA guild data.");
  const memberRole = await cssaGuild.roles.fetch(MEMBER_ROLE_ID);
  if (!memberRole) throw new Error("Couldn't get member role.");
  const members = memberRole.members;
  const memberUsernames = new Set(
    fetchedData
      .map((item) => item[BASEROW_ITEM_FIELDS.DISCORD_USERNAME])
      .map((username) => transformUsername(username)),
  );
  for (const member of members.values()) {
    if (!memberUsernames.has(member.user.username))
      eventPromises.push(member.roles.remove(memberRole));
  }

  return Promise.all(eventPromises);
}

export async function attachBaserowWebhookListener(expressApp: Express) {
  await refreshBaserowData();

  expressApp.use(express.json());

  expressApp.post(
    "/membership/update",
    async (request: Request<BaserowWebhook>, response) => {
      if (request.headers["x-cssa-secret"] != process.env.WEBSOCKET_SECRET) {
        console.warn("Illegal websocket update.");
        response.status(401).send();
        return;
      }
      console.log("Received baserow webhook.");
      const webhookBody: BaserowWebhook = request.body;

      // Collect all async operations for better concurrency
      const promises: Promise<void>[] = [];

      switch (webhookBody.event_type) {
        case "rows.created": {
          for (const item of webhookBody.items) {
            promises.push(
              onRowCreate(item).then(() => {
                baserowData.set(item.id, item);
              }),
            );
          }
          break;
        }
        case "rows.updated": {
          for (const item of webhookBody.items) {
            const oldItem = webhookBody.old_items.find(
              (oldItem) => oldItem.id === item.id,
            );
            if (oldItem) {
              promises.push(
                onRowUpdate(item, oldItem).then(() => {
                  baserowData.set(item.id, item);
                }),
              );
            } else {
              console.warn("Updated item not found in webhookBody.old_items");
            }
          }
          break;
        }
        case "rows.deleted": {
          for (const id of webhookBody.row_ids) {
            const item = baserowData.get(id);
            if (item) {
              promises.push(
                onRowDelete(item).then(() => {
                  baserowData.delete(id);
                }),
              );
            } else {
              console.warn("Deleted item not found in baserowData");
            }
          }
          break;
        }
      }

      response.status(204).send();

      await Promise.all(promises);
    },
  );
}

class MemberNotFoundError extends Error {}

async function getGuildAndUser(
  guildId: string,
  username: string,
): Promise<[Guild, GuildMember]> {
  username = transformUsername(username);
  const guild = await discordClient.guilds.fetch(guildId);
  if (!guild) throw new Error("Couldn't fetch guild data.");
  const matchingMembers = await guild.members.fetch({ query: username });
  for (const member of matchingMembers.values()) {
    if (member.user.username === username) return [guild, member];
  }
  throw new MemberNotFoundError("Couldn't find member in guild.");
}

export async function performRoleUpdate(
  username: string,
  roleType: "member" | "lifeMember",
  operation: "add" | "remove",
) {
  const [guild, member] = await getGuildAndUser(CSSA_SERVER_ID, username);
  const role = await guild.roles.fetch(
    roleType === "member" ? MEMBER_ROLE_ID : LIFE_MEMBER_ROLE_ID,
  );
  if (!role) throw new Error("Couldn't get role.");
  await (operation === "add"
    ? member.roles.add(role)
    : member.roles.remove(role));
}

export async function onRowCreate(row: BaserowItem) {
  const username = row[BASEROW_ITEM_FIELDS.DISCORD_USERNAME];
  if (!username) return;
  try {
    await performRoleUpdate(username, "member", "add");
    if (isLifeMember(row)) {
      await performRoleUpdate(username, "lifeMember", "add");
    }
  } catch (error) {
    console.warn("Error while processing onRowCreate:", error);
  }
}

export async function onRowUpdate(row: BaserowItem, oldRow: BaserowItem) {
  if (
    row[BASEROW_ITEM_FIELDS.DISCORD_USERNAME] !==
    oldRow[BASEROW_ITEM_FIELDS.DISCORD_USERNAME]
  ) {
    const oldUsername = oldRow[BASEROW_ITEM_FIELDS.DISCORD_USERNAME];
    if (oldUsername) {
      try {
        await performRoleUpdate(oldUsername, "member", "remove");
      } catch (error) {
        if (!(error instanceof MemberNotFoundError)) {
          console.warn("Error while processing onRowUpdate:", error);
        }
      }
      // Never remove life member role, as it is often added manually
    }
    const newUsername = row[BASEROW_ITEM_FIELDS.DISCORD_USERNAME];
    if (newUsername) {
      try {
        await performRoleUpdate(newUsername, "member", "add");
        if (isLifeMember(row)) {
          await performRoleUpdate(newUsername, "lifeMember", "add");
        }
      } catch (error) {
        console.warn("Error while processing onRowUpdate:", error);
      }
    }
  }
  if (row[BASEROW_ITEM_FIELDS.FLAGS] !== oldRow[BASEROW_ITEM_FIELDS.FLAGS]) {
    // Flags changed
    // Add life member role if appropriate
    const username = row[BASEROW_ITEM_FIELDS.DISCORD_USERNAME];
    if (!username) return;
    if (!isLifeMember(row)) return;
    try {
      await performRoleUpdate(username, "lifeMember", "add");
    } catch (error) {
      console.warn("Error while processing onRowUpdate:", error);
    }
  }
}

export async function onRowDelete(row: BaserowItem) {
  const username = row[BASEROW_ITEM_FIELDS.DISCORD_USERNAME];
  if (!username) return;
  try {
    await performRoleUpdate(username, "member", "remove");
  } catch (error) {
    console.warn("Error while processing onRowDelete:", error);
  }
}
