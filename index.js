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

const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://zoya-recharge-2-default-rtdb.firebaseio.com";


/* =========================
   CHECK ENVIRONMENT VARIABLES
========================= */

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing");
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}


/* =========================
   FIREBASE SERVICE ACCOUNT
========================= */

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} catch (error) {
  console.error(
    "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:",
    error.message
  );

  process.exit(1);
}


if (
  !serviceAccount.project_id ||
  !serviceAccount.client_email ||
  !serviceAccount.private_key
) {
  console.error(
    "Firebase service account JSON must contain project_id, client_email and private_key."
  );

  process.exit(1);
}


/*
  Render environment variables can contain
  literal \n instead of real line breaks.
*/

serviceAccount.private_key =
  serviceAccount.private_key.replace(/\\n/g, "\n");


/* =========================
   INITIALIZE FIREBASE
========================= */

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
} catch (error) {
  console.error(
    "Firebase initialization failed:",
    error.message
  );

  process.exit(1);
}


const db = admin.database();


/* =========================
   DISCORD CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});


/* =========================
   HELPER FUNCTIONS
========================= */

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


function num(value) {

  const n = Number(
    String(value ?? "")
      .replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(n) ? n : 0;
}


/* =========================
   CHECK REQUEST STATUS
========================= */

function pending(data) {

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


/* =========================
   CREATE REQUEST OBJECT
========================= */

function makeRequest(key, data) {

  return {

    key,

    data,

    userId: String(
      pick(
        data,
        [
          "userId",
          "uid",
          "user_id",
          "userid"
        ],
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
        [
          "amount",
          "money",
          "requestAmount"
        ],
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


/* =========================
   FIND USER
========================= */

async function findUser(req) {

  const snap =
    await db.ref("users").once("value");

  const users =
    snap.val() || {};


  if (
    req.userId &&
    users[req.userId]
  ) {

    return {
      key: req.userId,
      data: users[req.userId]
    };

  }


  for (
    const [key, data]
    of Object.entries(users)
  ) {

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
      req.mobile &&
      mobile === req.mobile
    ) {

      return {
        key,
        data
      };

    }

  }


  return null;
}


/* =========================
   WALLET
========================= */

function wallet(data) {

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


/* =========================
   DISCORD MESSAGE
========================= */

function alertMessage(req) {

  const embed =
    new EmbedBuilder()

      .setTitle(
        "💰 NEW ADD MONEY REQUEST"
      )

      .addFields(

        {
          name: "👤 Name",
          value:
            req.name ||
            "Not provided",
          inline: true
        },

        {
          name: "📱 Mobile",
          value:
            req.mobile ||
            "Not provided",
          inline: true
        },

        {
          name: "💵 Amount",
          value:
            `₹${req.amount.toFixed(2)}`,
          inline: true
        },

        {
          name: "🔖 UTR / Reference",
          value:
            req.utr ||
            "Not provided"
        },

        {
          name: "🆔 Request ID",
          value:
            String(req.key)
        }

      )

      .setTimestamp();


  const buttons =
    new ActionRowBuilder()
      .addComponents(

        new ButtonBuilder()
          .setCustomId(
            `ACCEPT:${req.key}`
          )
          .setLabel("ACCEPT")
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            `REJECT:${req.key}`
          )
          .setLabel("REJECT")
          .setStyle(
            ButtonStyle.Danger
          )

      );


  return {

    embeds: [embed],

    components: [
      buttons
    ]

  };

}


/* =========================
   FIND DISCORD CHANNEL
========================= */

async function getChannel() {

  for (
    const guild
    of client.guilds.cache.values()
  ) {

    const channel =
      guild.channels.cache.find(
        (c) =>
          c.isTextBased() &&
          c.name === CHANNEL_NAME
      );


    if (channel) {
      return channel;
    }

  }


  return null;
}


/* =========================
   PREVENT DUPLICATE ALERTS
========================= */

const sentRequests =
  new Set();


/* =========================
   SEND REQUEST TO DISCORD
========================= */

async function sendRequest(snapshot) {

  if (
    !snapshot ||
    !snapshot.exists()
  ) {
    return;
  }


  const data =
    snapshot.val() || {};

  const key =
    snapshot.key;


  if (!pending(data)) {
    return;
  }


  if (sentRequests.has(key)) {
    return;
  }


  const req =
    makeRequest(
      key,
      data
    );


  if (req.amount <= 0) {
    return;
  }


  const channel =
    await getChannel();


  if (!channel) {

    console.log(
      `Channel "${CHANNEL_NAME}" not found.`
    );

    return;
  }


  sentRequests.add(key);


  try {

    await channel.send(
      alertMessage(req)
    );

    console.log(
      "New Add Money alert:",
      key
    );

  } catch (error) {

    sentRequests.delete(key);

    console.error(
      "Discord message failed:",
      error.message
    );

  }

}


/* =========================
   CLAIM REQUEST
========================= */

async function claimRequest(
  key,
  interaction
) {

  const requestRef =
    db.ref(
      `add_history/${key}`
    );


  const result =
    await requestRef.transaction(
      (current) => {

        if (!current) {
          return current;
        }


        const status =
          String(
            pick(
              current,
              [
                "status",
                "requestStatus",
                "state"
              ],
              "pending"
            )
          ).toLowerCase();


        if (
          [
            "approved",
            "accepted",
            "success",
            "successful",
            "rejected",
            "declined",
            "failed",
            "cancelled",
            "canceled",
            "processing"
          ].includes(status)
        ) {

          return;

        }


        return {

          ...current,

          status:
            "processing",

          processingBy:
            interaction.user.tag,

          processingAt:
            admin.database.ServerValue.TIMESTAMP

        };

      }
    );


  if (!result.committed) {
    return null;
  }


  return result.snapshot.val();

}


/* =========================
   ACCEPT REQUEST
========================= */

async function acceptRequest(
  key,
  interaction
) {

  const requestRef =
    db.ref(
      `add_history/${key}`
    );


  const claimedData =
    await claimRequest(
      key,
      interaction
    );


  if (!claimedData) {

    return {

      ok: false,

      message:
        "This request was already processed."

    };

  }


  const req =
    makeRequest(
      key,
      claimedData
    );


  if (req.amount <= 0) {

    await requestRef.update({
      status: "failed"
    });

    throw new Error(
      "Invalid amount."
    );

  }


  const user =
    await findUser(req);


  if (!user) {

    await requestRef.update({

      status:
        "pending",

      error:
        "User not found in Firebase."

    });


    throw new Error(
      "User not found in Firebase."
    );

  }


  const userRef =
    db.ref(
      `users/${user.key}`
    );


  const result =
    await userRef.transaction(
      (current) => {

        if (!current) {
          return current;
        }


        const oldBalance =
          wallet(current);


        const newBalance =
          oldBalance +
          req.amount;


        return {

          ...current,

          balance:
            newBalance,

          wallet:
            newBalance

        };

      }
    );


  if (!result.committed) {

    await requestRef.update({
      status: "pending"
    });


    throw new Error(
      "Wallet update failed."
    );

  }


  await requestRef.update({

    status:
      "approved",

    approvedAmount:
      req.amount,

    approvedBy:
      interaction.user.tag,

    processedAt:
      admin.database.ServerValue.TIMESTAMP

  });


  return {

    ok: true,

    amount:
      req.amount

  };

}


/* =========================
   REJECT REQUEST
========================= */

async function rejectRequest(
  key,
  interaction
) {

  const ref =
    db.ref(
      `add_history/${key}`
    );


  const result =
    await ref.transaction(
      (current) => {

        if (!current) {
          return current;
        }


        const status =
          String(
            pick(
              current,
              [
                "status",
                "requestStatus",
                "state"
              ],
              "pending"
            )
          ).toLowerCase();


        if (
          [
            "approved",
            "accepted",
            "success",
            "successful",
            "rejected",
            "declined",
            "failed",
            "cancelled",
            "canceled",
            "processing"
          ].includes(status)
        ) {

          return;

        }


        return {

          ...current,

          status:
            "rejected",

          rejectedBy:
            interaction.user.tag,

          processedAt:
            admin.database.ServerValue.TIMESTAMP

        };

      }
    );


  return result.committed;

}


/* =========================
   BOT READY
========================= */

client.once(
  Events.ClientReady,
  async (bot) => {

    console.log(
      `Discord bot online: ${bot.user.tag}`
    );


    const ref =
      db.ref(
        "add_history"
      );


    const existing =
      await ref.once(
        "value"
      );


    const data =
      existing.val() || {};


    for (
      const [key, value]
      of Object.entries(data)
    ) {

      await sendRequest({

        exists: () => true,

        key,

        val: () => value

      });

    }


    ref.on(
      "child_added",
      sendRequest
    );


    console.log(
      "Watching Firebase /add_history"
    );

  }
);


/* =========================
   BUTTON HANDLER
========================= */

client.on(
  Events.InteractionCreate,
  async (interaction) => {

    if (!interaction.isButton()) {
      return;
    }


    const parts =
      interaction.customId
        .split(":");


    const action =
      parts[0];


    const key =
      parts
        .slice(1)
        .join(":");


    if (!key) {
      return;
    }


    await interaction.deferUpdate();


    try {

      /* ACCEPT */

      if (
        action === "ACCEPT"
      ) {

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
            `✅ ACCEPTED\n₹${result.amount.toFixed(
              2
            )} wallet में add हो गया।`,

          embeds: [],

          components: []

        });


        return;

      }


      /* REJECT */

      if (
        action === "REJECT"
      ) {

        const ok =
          await rejectRequest(
            key,
            interaction
          );


        await interaction.editReply({

          content:
            ok
              ? "❌ REJECTED — Add Money request reject कर दी गई।"
              : "⚠️ यह request पहले ही process हो चुकी है।",

          embeds: [],

          components: []

        });

      }

    } catch (error) {

      console.error(error);


      await interaction
        .editReply({

          content:
            `⚠️ Error: ${error.message}`,

          embeds: [],

          components: []

        })
        .catch(() => {});

    }

  }
);


/* =========================
   ERROR HANDLERS
========================= */

process.on(
  "unhandledRejection",
  (error) => {

    console.error(
      "Unhandled rejection:",
      error
    );

  }
);


process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "Uncaught exception:",
      error
    );

  }
);


/* =========================
   LOGIN
========================= */

client
  .login(TOKEN)
  .catch((error) => {

    console.error(
      "Discord login failed:",
      error.message
    );

    process.exit(1);

  });
