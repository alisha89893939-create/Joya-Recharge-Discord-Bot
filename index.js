const admin = require("firebase-admin");
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_NAME = "add-money-alert";
const DATABASE_URL = "https://zoya-recharge-2-default-rtdb.firebaseio.com";

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing");
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}

const serviceAccount =
  JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL
});

const db = admin.database();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function pick(obj, keys, fallback = "") {
  for (const key of keys) {
    if (
      obj &&
      obj[key] !== undefined &&
      obj[key] !== null &&
      String(obj[key]).trim() !== ""
    ) {
      return obj[key];
    }
  }
  return fallback;
}

function num(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function pending(data) {
  const s = String(
    pick(data, ["status", "requestStatus", "state"], "pending")
  ).toLowerCase();

  return ![
    "approved",
    "accepted",
    "success",
    "successful",
    "rejected",
    "declined",
    "failed",
    "cancelled",
    "canceled"
  ].includes(s);
}

function makeRequest(key, data) {
  return {
    key,
    data,
    userId: String(
      pick(data, ["userId", "uid", "user_id", "userid"], "")
    ),
    mobile: String(
      pick(
        data,
        ["mobile", "phone", "number", "mobileNumber", "phoneNumber"],
        ""
      )
    ),
    name: String(
      pick(data, ["name", "userName", "username", "customerName"], "")
    ),
    amount: num(
      pick(data, ["amount", "money", "requestAmount"], 0)
    ),
    utr: String(
      pick(
        data,
        [
          "utr",
          "UTR",
          "utrNumber",
          "reference",
          "referenceNumber",
          "transactionId",
          "txnId"
        ],
        ""
      )
    )
  };
}

async function findUser(req) {
  const snap = await db.ref("users").once("value");
  const users = snap.val() || {};

  if (req.userId && users[req.userId]) {
    return { key: req.userId, data: users[req.userId] };
  }

  for (const [key, data] of Object.entries(users)) {
    const mobile = String(
      pick(
        data,
        ["mobile", "phone", "number", "mobileNumber", "phoneNumber"],
        ""
      )
    );

    if (req.mobile && mobile === req.mobile) {
      return { key, data };
    }
  }

  return null;
}

function wallet(data) {
  return num(
    pick(data, ["balance", "wallet", "walletBalance", "money"], 0)
  );
}

function alertMessage(req) {
  const embed = new EmbedBuilder()
    .setTitle("💰 NEW ADD MONEY REQUEST")
    .addFields(
      {
        name: "👤 Name",
        value: req.name || "Not provided",
        inline: true
      },
      {
        name: "📱 Mobile",
        value: req.mobile || "Not provided",
        inline: true
      },
      {
        name: "💵 Amount",
        value: `₹${req.amount.toFixed(2)}`,
        inline: true
      },
      {
        name: "🔖 UTR / Reference",
        value: req.utr || "Not provided"
      },
      {
        name: "🆔 Request ID",
        value: `\`${req.key}\``
      }
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ACCEPT:${req.key}`)
      .setLabel("ACCEPT")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`REJECT:${req.key}`)
      .setLabel("REJECT")
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [buttons]
  };
}

async function getChannel() {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      c =>
        c.isTextBased() &&
        c.name === CHANNEL_NAME
    );

    if (channel) return channel;
  }

  return null;
}

const sentRequests = new Set();

async function sendRequest(snapshot) {
  if (!snapshot.exists()) return;

  const data = snapshot.val() || {};
  const key = snapshot.key;

  if (!pending(data)) return;
  if (sentRequests.has(key)) return;

  const req = makeRequest(key, data);

  if (req.amount <= 0) return;

  const channel = await getChannel();

  if (!channel) {
    console.log("add-money-alert channel not found");
    return;
  }

  sentRequests.add(key);

  await channel.send(alertMessage(req));

  console.log("New Add Money alert:", key);
}

async function acceptRequest(key, interaction) {
  const requestRef = db.ref(`add_history/${key}`);

  const snap = await requestRef.once("value");

  if (!snap.exists()) {
    throw new Error("Request not found.");
  }

  const data = snap.val() || {};

  if (!pending(data)) {
    return {
      ok: false,
      message: "This request was already processed."
    };
  }

  const req = makeRequest(key, data);

  if (req.amount <= 0) {
    throw new Error("Invalid amount.");
  }

  const user = await findUser(req);

  if (!user) {
    throw new Error("User not found in Firebase.");
  }

  const userRef = db.ref(`users/${user.key}`);

  const result = await userRef.transaction(current => {
    if (!current) return current;

    const oldBalance = wallet(current);
    const newBalance = oldBalance + req.amount;

    return {
      ...current,
      balance: newBalance,
      wallet: newBalance
    };
  });

  if (!result.committed) {
    throw new Error("Wallet update failed.");
  }

  await requestRef.update({
    status: "approved",
    approvedAmount: req.amount,
    approvedBy: interaction.user.tag,
    processedAt: admin.database.ServerValue.TIMESTAMP
  });

  return {
    ok: true,
    amount: req.amount
  };
}

async function rejectRequest(key, interaction) {
  const ref = db.ref(`add_history/${key}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    return false;
  }

  const data = snap.val() || {};

  if (!pending(data)) {
    return false;
  }

  await ref.update({
    status: "rejected",
    rejectedBy: interaction.user.tag,
    processedAt: admin.database.ServerValue.TIMESTAMP
  });

  return true;
}

client.once(Events.ClientReady, async bot => {
  console.log(`Discord bot online: ${bot.user.tag}`);

  const ref = db.ref("add_history");

  const existing = await ref.once("value");
  const data = existing.val() || {};

  for (const [key, value] of Object.entries(data)) {
    await sendRequest({
      exists: () => true,
      key,
      val: () => value
    });
  }

  ref.on("child_added", sendRequest);

  console.log("Watching Firebase /add_history");
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split(":");
  const action = parts[0];
  const key = parts.slice(1).join(":");

  if (!key) return;

  await interaction.deferUpdate();

  try {
    if (action === "ACCEPT") {
      const result = await acceptRequest(key, interaction);

      if (!result.ok) {
        await interaction.editReply({
          content: `⚠️ ${result.message}`,
          embeds: [],
          components: []
        });
        return;
      }

      await interaction.editReply({
        content:
          `✅ ACCEPTED\n₹${result.amount.toFixed(2)} wallet में add हो गया।`,
        embeds: [],
        components: []
      });
    }

    if (action === "REJECT") {
      const ok = await rejectRequest(key, interaction);

      await interaction.editReply({
        content: ok
          ? "❌ REJECTED — Add Money request reject कर दी गई।"
          : "⚠️ यह request पहले ही process हो चुकी है।",
        embeds: [],
        components: []
      });
    }
  } catch (error) {
    console.error(error);

    await interaction.editReply({
      content: `⚠️ Error: ${error.message}`,
      embeds: [],
      components: []
    }).catch(() => {});
  }
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

client.login(TOKEN);
