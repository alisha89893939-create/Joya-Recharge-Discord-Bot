
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.DISCORD_TOKEN;

function fixKey(v) {
  if (!v) return "";

  let s = String(v).trim();

  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j.private_key) {
        return String(j.private_key).replace(/\\n/g, "\n");
      }
    } catch (_) {}
  }

  return s
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\\n/g, "\n");
}

function firebaseCredential() {
  const whole =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT;

  if (whole && whole.trim()) {
    try {
      return admin.credential.cert(JSON.parse(whole));
    } catch (_) {}

    try {
      return admin.credential.cert(
        JSON.parse(
          Buffer.from(whole.trim(), "base64").toString("utf8")
        )
      );
    } catch (_) {}
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID || "zoya-recharge-2";

  const clientEmail =
    process.env.FIREBASE_CLIENT_EMAIL || "";

  const privateKey =
    fixKey(process.env.FIREBASE_PRIVATE_KEY || "");

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Set FIREBASE_SERVICE_ACCOUNT_JSON OR FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY."
    );
  }

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY must contain BEGIN PRIVATE KEY and END PRIVATE KEY."
    );
  }

  return admin.credential.cert({
    projectId,
    clientEmail,
    privateKey
  });
}

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing");
  process.exit(1);
}

let db;

try {
  admin.initializeApp({
    credential: firebaseCredential(),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://zoya-recharge-2-default-rtdb.firebaseio.com"
  });

  db = admin.database();

  console.log("Firebase initialized successfully.");
} catch (e) {
  console.error(
    "Firebase initialization failed:",
    e.message
  );
  process.exit(1);
}

const web = express();

web.get("/", (_req, res) => {
  res
    .status(200)
    .send("Joya Recharge Discord Bot is running.");
});

web.get("/health", (_req, res) => {
  res.json({ ok: true });
});

web.listen(PORT, "0.0.0.0", () => {
  console.log("Health server on port " + PORT);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHANNEL_ID =
  process.env.DISCORD_CHANNEL_ID || "";

const seen = new Set();

function pick(o, keys, fallback = "") {
  for (const k of keys) {
    if (
      o &&
      o[k] !== undefined &&
      o[k] !== null &&
      o[k] !== ""
    ) {
      return o[k];
    }
  }

  return fallback;
}

function amount(d) {
  const n = Number(
    pick(
      d,
      ["amount", "requestAmount", "money", "price"],
      0
    )
  );

  return Number.isFinite(n) ? n : 0;
}

function mobile(d) {
  return String(
    pick(
      d,
      ["mobile", "mobileNumber", "phone", "number"],
      ""
    )
  ).trim();
}

function name(d) {
  return String(
    pick(
      d,
      ["name", "userName", "fullName"],
      "User"
    )
  ).trim();
}

function utr(d) {
  return String(
    pick(
      d,
      [
        "utr",
        "utrNumber",
        "transactionId",
        "txnId",
        "referenceNumber",
        "ref"
      ],
      ""
    )
  ).trim();
}

function pending(d) {
  return [
    "pending",
    "requested",
    "processing",
    "new",
    "waiting",
    "under_review"
  ].includes(
    String(
      pick(
        d,
        ["status", "requestStatus", "paymentStatus"],
        "pending"
      )
    ).toLowerCase()
  );
}

async function findUser(data) {
  const uid = pick(data, ["userId", "uid"], "");

  if (uid) {
    const s = await db
      .ref("users/" + uid)
      .get();

    if (s.exists()) {
      return {
        key: uid,
        data: s.val()
      };
    }
  }

  const m = mobile(data);

  if (!m) return null;

  const s = await db.ref("users").get();
  const users = s.val() || {};

  for (const [key, u] of Object.entries(users)) {
    if (
      String(
        pick(
          u,
          ["mobile", "mobileNumber", "phone", "number"],
          ""
        )
      ) === m
    ) {
      return {
        key,
        data: u
      };
    }
  }

  return null;
}

async function acceptRequest(key, data) {
  const n = amount(data);

  if (!(n > 0)) {
    throw new Error("Invalid amount.");
  }

  const u = await findUser(data);

  if (!u) {
    throw new Error("User not found.");
  }

  const result = await db
    .ref("users/" + u.key)
    .transaction(cur => {
      if (!cur) return cur;

      const old = Number(
        cur.balance ??
        cur.wallet ??
        cur.walletBalance ??
        0
      );

      const next = old + n;

      return {
        ...cur,
        balance: next,
        wallet: next,
        walletBalance: next,
        updatedAt: Date.now()
      };
    });

  if (!result.committed) {
    throw new Error(
      "Wallet update was not committed."
    );
  }

  await db
    .ref("add_history/" + key)
    .update({
      status: "accepted",
      approved: true,
      processed: true,
      processedAt: Date.now(),
      processedBy:
        "Joya Recharge Discord Bot"
    });

  return result.snapshot.val().balance;
}

async function rejectRequest(key) {
  await db
    .ref("add_history/" + key)
    .update({
      status: "rejected",
      approved: false,
      processed: true,
      processedAt: Date.now(),
      processedBy:
        "Joya Recharge Discord Bot"
    });
}

function embed(key, d) {
  return new EmbedBuilder()
    .setTitle("💰 New Add Money Request")
    .setDescription(
      "A new wallet top-up request is waiting for admin action."
    )
    .addFields(
      {
        name: "👤 Name",
        value: name(d),
        inline: true
      },
      {
        name: "📱 Mobile",
        value: mobile(d) || "Not provided",
        inline: true
      },
      {
        name: "💵 Amount",
        value: "₹" + amount(d),
        inline: true
      },
      {
        name: "🔖 UTR / Reference",
        value: utr(d) || "Not provided",
        inline: false
      },
      {
        name: "🆔 Request ID",
        value: String(key),
        inline: false
      }
    )
    .setTimestamp();
}

function row(key) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("accept:" + key)
      .setLabel("ACCEPT")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("reject:" + key)
      .setLabel("REJECT")
      .setStyle(ButtonStyle.Danger)
  );
}

async function channel() {
  if (CHANNEL_ID) {
    const c = await client.channels
      .fetch(CHANNEL_ID)
      .catch(() => null);

    if (c && c.isTextBased()) {
      return c;
    }
  }

  for (const g of client.guilds.cache.values()) {
    const c = g.channels.cache.find(
      x =>
        x.isTextBased() &&
        x.name === "add-money-alert"
    );

    if (c) return c;
  }

  for (const g of client.guilds.cache.values()) {
    const c = g.channels.cache.find(
      x => x.isTextBased()
    );

    if (c) return c;
  }

  return null;
}

async function scan() {
  try {
    const s = await db
      .ref("add_history")
      .get();

    if (!s.exists()) return;

    for (const [key, d] of Object.entries(
      s.val() || {}
    )) {
      if (
        !d ||
        !pending(d) ||
        seen.has(key)
      ) {
        continue;
      }

      const c = await channel();

      if (!c) {
        console.error(
          "No Discord text channel available."
        );
        return;
      }

      await c.send({
        content:
          "🔔 **NEW ADD MONEY REQUEST**",
        embeds: [embed(key, d)],
        components: [row(key)]
      });

      seen.add(key);

      console.log(
        "Sent alert for " + key
      );
    }
  } catch (e) {
    console.error(
      "Firebase scan failed:",
      e.message
    );
  }
}

client.once("ready", async () => {
  console.log(
    "Discord logged in as " +
    client.user.tag
  );

  await scan();

  setInterval(scan, 5000);
});

client.on(
  "interactionCreate",
  async interaction => {
    if (!interaction.isButton()) return;

    const [action, key] =
      interaction.customId.split(":");

    if (!key) return;

    await interaction.deferUpdate();

    try {
      const s = await db
        .ref("add_history/" + key)
        .get();

      if (!s.exists()) {
        throw new Error(
          "Request not found in Firebase."
        );
      }

      const d = s.val();

      if (!pending(d)) {
        await interaction.editReply({
          content:
            "⚠️ This request is already processed.",
          components: []
        });

        return;
      }

      if (action === "accept") {
        const balance =
          await acceptRequest(key, d);

        await interaction.editReply({
          content:
            "✅ **ACCEPTED** — ₹" +
            amount(d) +
            " added to wallet. New balance: ₹" +
            balance,
          embeds: [
            embed(key, {
              ...d,
              status: "accepted"
            })
          ],
          components: []
        });
      }

      if (action === "reject") {
        await rejectRequest(key);

        await interaction.editReply({
          content:
            "❌ **REJECTED** — Request marked rejected in Firebase.",
          embeds: [
            embed(key, {
              ...d,
              status: "rejected"
            })
          ],
          components: []
        });
      }
    } catch (e) {
      console.error(
        "Button error:",
        e.message
      );

      await interaction
        .followUp({
          content: "❌ " + e.message,
          ephemeral: true
        })
        .catch(() => {});
    }
  }
);

client.login(TOKEN).catch(e => {
  console.error(
    "Discord login failed:",
    e.message
  );

  process.exit(1);
});
