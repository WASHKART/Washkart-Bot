const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const TOKEN = "EAAST7Y5o9b0BRcZAK3PthGE5ly9uL3VhGo2dQzSSW3gAzNZC41BeDmrfPqPJePlZAp6mlifrs3rZCg193u3d88DWzsSSo0JUvU5bdxvWZBygBfWalBZA9QKV57AmNkGdJbGCOj7ZA6yicAavQGxrDXvfNMnxa3ZA6woccfZCdGw13f2wVtkmpwgMqqUaXjnpJ23tuzwZDZD";
const PHONE_NUMBER_ID = "111939166779272";
const VERIFY_TOKEN = "washkart_verify_123";

// In-memory store (replace with Firebase for production)
const customers = {}; // { phone: { name, address } }
const sessions = {};  // { phone: { step, booking: {} } }

function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "idle", booking: {} };
  return sessions[phone];
}

function getToday() {
  return new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
}
function getTomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
}
function genOrderId() {
  return "FW-" + Math.floor(1000 + Math.random() * 9000);
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendButtons(to, body, buttons) {
  // buttons = [{ id, title }]
  await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title }
          }))
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendList(to, body, sections) {
  await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: "Select option",
          sections
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function handleMessage(phone, text) {
  const session = getSession(phone);
  const saved = customers[phone];
  const t = text.toLowerCase().trim();

  // Greeting or pickup trigger
  if (["hi","hello","hey","hii","pickup","book","start"].some(k => t.includes(k)) && session.step === "idle") {
    if (saved) {
      session.step = "confirm_details";
      await sendButtons(phone,
        `👋 Welcome back, ${saved.name}!\n\nUse your saved details?\n📍 ${saved.address}`,
        [
          { id: "use_saved", title: "✅ Yes, use these" },
          { id: "update_details", title: "✏️ Update details" }
        ]
      );
    } else {
      session.step = "get_address";
      session.booking = {};
      await sendMessage(phone, "👋 Welcome to *Washkart Laundry*! 🧺\n\nLet's book your pickup.\n\nPlease send me your *pickup address*:");
    }
    return;
  }

  // Confirm saved details
  if (session.step === "confirm_details") {
    if (text === "use_saved") {
      session.booking.name = saved.name;
      session.booking.address = saved.address;
      session.step = "select_date";
      await askDate(phone);
    } else if (text === "update_details") {
      customers[phone] = null;
      session.booking = {};
      session.step = "get_address";
      await sendMessage(phone, "📍 Please send me your new *pickup address*:");
    }
    return;
  }

  // Collect address (new customer)
  if (session.step === "get_address") {
    session.booking.address = text;
    session.step = "get_name";
    await sendMessage(phone, "👤 What's your *name*?");
    return;
  }

  // Collect name
  if (session.step === "get_name") {
    session.booking.name = text;
    customers[phone] = { name: text, address: session.booking.address };
    session.step = "select_date";
    await askDate(phone);
    return;
  }

  // Date selection
  if (session.step === "select_date") {
    if (text === "date_today") {
      session.booking.date = getToday();
      session.step = "select_slot";
      await askSlot(phone);
    } else if (text === "date_tomorrow") {
      session.booking.date = getTomorrow();
      session.step = "select_slot";
      await askSlot(phone);
    } else if (text === "date_custom") {
      session.step = "get_custom_date";
      await sendMessage(phone, "📅 Please type your preferred date (e.g. *26 April*):");
    }
    return;
  }

  // Custom date
  if (session.step === "get_custom_date") {
    session.booking.date = text;
    session.step = "select_slot";
    await askSlot(phone);
    return;
  }

  // Slot selection
  if (session.step === "select_slot") {
    if (text === "slot_morning") {
      session.booking.slot = "Morning (10 AM – 1 PM)";
    } else if (text === "slot_evening") {
      session.booking.slot = "Evening (5 PM – 8 PM)";
    } else {
      await askSlot(phone);
      return;
    }
    session.step = "idle";
    await confirmBooking(phone, session.booking);
    return;
  }

  // Pricing
  if (t.includes("price") || t.includes("rate") || t.includes("cost") || t.includes("charge")) {
    await sendMessage(phone,
      "💰 *Washkart Pricing*\n\n" +
      "👕 Wash & Fold — ₹40/kg (min 3kg)\n" +
      "👔 Wash & Iron — ₹60/kg\n" +
      "🧥 Dry Clean — from ₹80/piece\n" +
      "⚡ Express same day — +₹50\n\n" +
      "🚚 Free pickup & delivery above ₹300\n\n" +
      "Type *pickup* to book now!"
    );
    return;
  }

  // Track order
  if (t.includes("track") || t.includes("status") || t.includes("order")) {
    session.step = "tracking";
    await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):");
    return;
  }

  if (session.step === "tracking") {
    const statuses = [
      "✅ Picked up — currently being washed",
      "🫧 Washed — out for delivery",
      "✅ Delivered — enjoy your fresh clothes!"
    ];
    await sendMessage(phone, `*${text.toUpperCase()}*: ${statuses[Math.floor(Math.random() * statuses.length)]}`);
    session.step = "idle";
    return;
  }

  // Default
  await sendButtons(phone,
    "Hi! 👋 How can I help you today?",
    [
      { id: "btn_book", title: "📦 Book Pickup" },
      { id: "btn_price", title: "💰 Pricing" },
      { id: "btn_track", title: "🔍 Track Order" }
    ]
  );
  session.step = "idle";

  // Map button replies for default menu
  if (text === "btn_book") { session.step = "idle"; await handleMessage(phone, "pickup"); }
  if (text === "btn_price") await handleMessage(phone, "price");
  if (text === "btn_track") await handleMessage(phone, "track");
}

async function askDate(phone) {
  await sendButtons(phone,
    "📅 Which day works for pickup?",
    [
      { id: "date_today", title: `Today` },
      { id: "date_tomorrow", title: `Tomorrow` },
      { id: "date_custom", title: "📆 Choose date" }
    ]
  );
}

async function askSlot(phone) {
  await sendButtons(phone,
    "🕐 Pick your time slot:",
    [
      { id: "slot_morning", title: "🌅 10 AM – 1 PM" },
      { id: "slot_evening", title: "🌆 5 PM – 8 PM" }
    ]
  );
}

async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  const msg =
    `✅ *Booking Confirmed!*\n\n` +
    `🆔 Order ID: *${orderId}*\n` +
    `👤 Name: ${booking.name}\n` +
    `📍 Address: ${booking.address}\n` +
    `📅 Date: ${booking.date}\n` +
    `🕐 Slot: ${booking.slot}\n\n` +
    `Our team will reach you before pickup.\n` +
    `For queries call/WhatsApp: 7775066002\n\n` +
    `💰 Payment accepted via UPI/Cash at pickup.`;
  await sendMessage(phone, msg);
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Incoming messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const phone = msg.from;
    let text = "";

    if (msg.type === "text") {
      text = msg.text.body;
    } else if (msg.type === "interactive") {
      if (msg.interactive.type === "button_reply") {
        text = msg.interactive.button_reply.id;
      } else if (msg.interactive.type === "list_reply") {
        text = msg.interactive.list_reply.id;
      }
    }

    if (text) await handleMessage(phone, text);
    res.sendStatus(200);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart bot running on port ${PORT}`));
