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

// =====================================================
// CONFIG
// =====================================================

const TOKEN = process.env.DISCORD_TOKEN;

const CHANNEL_NAME = "add-money-alert";

const DATABASE_URL =
  "https://zoya-recharge-2-default-rtdb.firebaseio.com";

// =====================================================
// ENV CHECK
// =====================================================

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing");
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}

// =====================================================
// FIREBASE SERVICE ACCOUNT
// =====================================================

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  // Important fix for Render / Firebase private key
  if (serviceAccount.private_key) {
    serviceAccount.private_key = String(
      serviceAccount.private_key
    )
      .replace(/\\n/g, "\n")
      .replace(/\r\n/g, "\n")
      .trim();
  }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      "Firebase service account JSON is missing project_id, client_email or private_key"
    );
  }
} catch (error) {
  console.error(
    "Firebase service account JSON error:",
    error.message
  );
  process.exit(1);
}

// =====================================================
// FIREBASE INIT
// =====================================================

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });

  console.log("Firebase initialized successfully");
} catch (error) {
  console.error(
    "Firebase initialization failed:",
    error.message
  );
  process.exit(1);
}

const db = admin.database();

// =====================================================
// DISCORD CLIENT
// =====================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// =====================================================
// HELPERS
// =====================================================

function pick(obj, keys, fallback = "") {
  if (!obj || typeof obj !== "object") {
    return fallback;
  }

  for (const key of keys) {
    if (
      obj[key] !== undefined &&
      obj[key] !== null &&
      String(obj[key]).trim() !== ""
    ) {
      return obj[key];
    }
  }

  return fallback;
}

function num(value) {
  const n = Number(
    String(value ?? "").replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(n) ? n : 0;
}

function isPending(data) {
  const status = String(
    pick(
      data,
      ["status", "requestStatus", "state"],
      "pending"
    )
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
  ].includes(status);
}

// =====================================================
// REQUEST FORMAT
// =====================================================

function makeRequest(key, data) {
  return {
    key,

    data,

    userId: String(
      pick(
        data,
        ["userId", "uid", "user_id", "userid"],
        ""
      )
    ),

    mobile: String(
      pick(
        data,
        [
          "mobile",
          "phone",
          "number",
          "mobileNumber",
          "phoneNumber"
        ],
        ""
      )
    ),

    name: String(
      pick(
        data,
        [
          "name",
          "userName",
          "username",
          "customerName"
        ],
        ""
      )
    ),

    amount: num(
      pick(
        data,
        ["amount", "money", "requestAmount"],
        0
      )
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

// =====================================================
// FIND USER
// =====================================================

async function findUser(request) {
  const snapshot = await db.ref("users").once("value");

  const users = snapshot.val() || {};

  // First try user ID
  if (request.userId && users[request.userId]) {
    return {
      key: request.userId,
      data: users[request.userId]
    };
  }

  // Then try mobile number
  for (const [key, data] of Object.entries(users)) {
    const mobile = String(
      pick(
        data,
        [
          "mobile",
          "phone",
          "number",
          "mobileNumber",
          "phoneNumber"
        ],
        ""
      )
    );

    if (
      request.mobile &&
      mobile === request.mobile
    ) {
      return {
        key,
        data
      };
    }
  }

  return null;
}

// =====================================================
// WALLET
// =====================================================

function getWallet(data) {
  return num(
    pick(
      data,
      [
        "balance",
        "wallet",
        "walletBalance",
        "money"
      ],
      0
    )
  );
}

// =====================================================
// DISCORD CHANNEL
// =====================================================

async function getChannel() {
  const guilds = client.guilds.cache;

  for (const guild of guilds.values()) {
    const channel = guild.channels.cache.find(
      ch =>
        ch.name === CHANNEL_NAME &&
        ch.isTextBased()
    );

    if (channel) {
      return channel;
    }
  }

  return null;
}

// =====================================================
// ALERT MESSAGE
// =====================================================

function alertMessage(request) {
  const embed = new EmbedBuilder()
    .setTitle("💰 NEW ADD MONEY REQUEST")
    .setDescription(
      "A new wallet add-money request has been received."
    )
    .addFields(
      {
        name: "👤 Name",
        value: request.name || "Not provided",
        inline: true
      },
      {
        name: "📱 Mobile",
        value: request.mobile || "Not provided",
        inline: true
      },
      {
        name: "💵 Amount",
        value: `₹${request.amount.toFixed(2)}`,
        inline: true
      },
      {
        name: "🔢 UTR / Reference",
        value: request.utr || "Not provided",
        inline: false
      },
      {
        name: "🆔 Request ID",
        value: String(request.key),
        inline: false
      }
    )
    .setFooter({
      text: "Joya Recharge Admin"
    })
    .setTimestamp();

  const buttons =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ACCEPT:${request.key}`)
        .setLabel("ACCEPT")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`REJECT:${request.key}`)
        .setLabel("REJECT")
        .setStyle(ButtonStyle.Danger)
    );

  return {
    embeds: [embed],
    components: [buttons]
  };
}

// =====================================================
// CHECK IF ALREADY PROCESSED
// =====================================================

async function exists(key) {
  const snapshot = await db
    .ref(`add_history/${key}`)
    .once("value");

  const data = snapshot.val();

  if (!data) {
    return false;
  }

  const status = String(
    pick(
      data,
      ["status", "requestStatus", "state"],
      "pending"
    )
  ).toLowerCase();

  return [
    "approved",
    "accepted",
    "success",
    "successful",
    "rejected",
    "declined",
    "failed",
    "cancelled",
    "canceled"
  ].includes(status);
}

// =====================================================
// SEND REQUEST TO DISCORD
// =====================================================

async function sendRequest(key, data) {
  try {
    if (!isPending(data)) {
      return;
    }

    // Do not send duplicate processed request
    if (await exists(key)) {
      return;
    }

    const channel = await getChannel();

    if (!channel) {
      console.error(
        `Discord channel #${CHANNEL_NAME} not found`
      );
      return;
    }

    const request = makeRequest(key, data);

    const message = await channel.send(
      alertMessage(request)
    );

    // Save Discord message information
    await db
      .ref(`add_history/${key}`)
      .update({
        discordMessageId: message.id,
        discordChannelId: channel.id,
        discordSentAt:
          admin.database.ServerValue.TIMESTAMP
      });

    console.log(
      `Add Money request sent to Discord: ${key}`
    );
  } catch (error) {
    console.error(
      "sendRequest error:",
      error
    );
  }
}

// =====================================================
// ACCEPT REQUEST
// =====================================================

async function acceptRequest(key, interaction) {
  const ref = db.ref(`add_history/${key}`);

  const snapshot = await ref.once("value");

  if (!snapshot.exists()) {
    return {
      ok: false,
      message: "Request not found."
    };
  }

  const requestData = snapshot.val();

  if (!isPending(requestData)) {
    return {
      ok: false,
      message: "This request has already been processed."
    };
  }

  const request = makeRequest(
    key,
    requestData
  );

  if (request.amount <= 0) {
    return {
      ok: false,
      message: "Invalid request amount."
    };
  }

  const user = await findUser(request);

  if (!user) {
    return {
      ok: false,
      message:
        "User not found. Wallet was not updated."
    };
  }

  const oldWallet = getWallet(user.data);

  const newWallet =
    oldWallet + request.amount;

  // Update wallet
  await db
    .ref(`users/${user.key}`)
    .update({
      balance: newWallet,
      wallet: newWallet
    });

  // Mark request approved
  await ref.update({
    status: "approved",
    approved: true,
    approvedBy: interaction.user.tag,
    processedAt:
      admin.database.ServerValue.TIMESTAMP,
    oldWallet: oldWallet,
    addedAmount: request.amount,
    newWallet: newWallet
  });

  return {
    ok: true,
    amount: request.amount,
    oldWallet,
    newWallet,
    userKey: user.key
  };
}

// =====================================================
// REJECT REQUEST
// =====================================================

async function rejectRequest(key, interaction) {
  const ref = db.ref(`add_history/${key}`);

  const snapshot = await ref.once("value");

  if (!snapshot.exists()) {
    return {
      ok: false,
      message: "Request not found."
    };
  }

  const data = snapshot.val();

  if (!isPending(data)) {
    return {
      ok: false,
      message: "This request has already been processed."
    };
  }

  await ref.update({
    status: "rejected",
    rejectedBy: interaction.user.tag,
    processedAt:
      admin.database.ServerValue.TIMESTAMP
  });

  return {
    ok: true
  };
}

// =====================================================
// BOT READY
// =====================================================

client.once(
  Events.ClientReady,
  async bot => {
    console.log(
      `Discord bot logged in as ${bot.user.tag}`
    );

    console.log(
      `Watching Firebase /add_history`
    );

    console.log(
      `Discord channel: #${CHANNEL_NAME}`
    );

    // Existing requests
    try {
      const ref = db.ref("add_history");

      const snapshot =
        await ref.once("value");

      const data =
        snapshot.val() || {};

      for (
        const [key, value]
        of Object.entries(data)
      ) {
        if (isPending(value)) {
          await sendRequest(key, value);
        }
      }
    } catch (error) {
      console.error(
        "Existing request scan error:",
        error
      );
    }

    // New requests
    const ref = db.ref("add_history");

    ref.on(
      "child_added",
      async snapshot => {
        try {
          const key = snapshot.key;
          const data = snapshot.val();

          if (!key || !data) {
            return;
          }

          if (!isPending(data)) {
            return;
          }

          await sendRequest(
            key,
            data
          );
        } catch (error) {
          console.error(
            "child_added error:",
            error
          );
        }
      }
    );

    console.log(
      "Firebase listener started successfully"
    );
  }
);

// =====================================================
// DISCORD BUTTONS
// =====================================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    if (!interaction.isButton()) {
      return;
    }

    const parts =
      interaction.customId.split(":");

    const action = parts[0];

    const key =
      parts.slice(1).join(":");

    if (!key) {
      return;
    }

    await interaction.deferUpdate();

    try {
      // ===============================================
      // ACCEPT
      // ===============================================

      if (action === "ACCEPT") {
        const result =
          await acceptRequest(
            key,
            interaction
          );

        if (!result.ok) {
          await interaction.editReply({
            content:
              `⚠️ ${result.message}`,
            embeds: [],
            components: []
          });

          return;
        }

        await interaction.editReply({
          content:
            `✅ ACCEPTED\n\n` +
            `💰 ₹${result.amount.toFixed(2)} ` +
            `wallet में add किया गया।\n\n` +
            `💳 Old Wallet: ₹${result.oldWallet.toFixed(2)}\n` +
            `💳 New Wallet: ₹${result.newWallet.toFixed(2)}\n\n` +
            `👮 Approved by: ${interaction.user.tag}`,
          embeds: [],
          components: []
        });

        console.log(
          `ACCEPTED ${key} ₹${result.amount}`
        );

        return;
      }

      // ===============================================
      // REJECT
      // ===============================================

      if (action === "REJECT") {
        const result =
          await rejectRequest(
            key,
            interaction
          );

        if (!result.ok) {
          await interaction.editReply({
            content:
              `⚠️ ${result.message}`,
            embeds: [],
            components: []
          });

          return;
        }

        await interaction.editReply({
          content:
            `❌ REJECTED\n\n` +
            `Add Money request reject कर दिया गया।\n\n` +
            `👮 Rejected by: ${interaction.user.tag}`,
          embeds: [],
          components: []
        });

        console.log(
          `REJECTED ${key}`
        );

        return;
      }
    } catch (error) {
      console.error(
        "Button processing error:",
        error
      );

      try {
        await interaction.editReply({
          content:
            `⚠️ Error: ${error.message}`,
          embeds: [],
          components: []
        });
      } catch (_) {}
    }
  }
);

// =====================================================
// ERROR HANDLERS
// =====================================================

client.on(
  "error",
  error => {
    console.error(
      "Discord client error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// =====================================================
// LOGIN
// =====================================================

console.log("Starting Joya Recharge Discord Bot...");

client.login(TOKEN).catch(error => {
  console.error(
    "Discord login failed:",
    error.message
  );

  process.exit(1);
});
