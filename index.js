const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const TOKEN = "EAAST7Y5o9b0BRW88SOTRQqT2hJy62MgMRoTt0509KkEiRT8O74pSoOP8bmZBKTbfGEW8PhjIej3EP7JVZB1LKyM1ZCUGOwUeYck6HJbmDYviMWCKMPLLpA776ooDpTDWqMB5H2mnGhz635T7c31OxKGb7uQ4ZCZCrirw9ROQ2LIKRvq6GMGcAQqa1tQQxfsq2IwZDZD";
const PHONE_NUMBER_ID = "1119391667920272";
const VERIFY_TOKEN = "washkart_verify_123";

const SUPABASE_URL = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhdXN2eWJwcWF3eGxheXlxeGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMjE3NzYsImV4cCI6MjA5MjU5Nzc3Nn0.GWqlExeEX1VHAPFQ_YBJrFsOSFb5RS_ZZdxkDTMjjCM";
const DB = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

async function dbInsert(table, data) {
  const res = await axios.post(`${DB}/${table}`, data, { headers: SB_HEADERS });
  return res.data;
}
async function dbSelect(table, filter) {
  const res = await axios.get(`${DB}/${table}?${filter}`, { headers: SB_HEADERS });
  return res.data;
}
async function dbUpdate(table, filter, data) {
  const res = await axios.patch(`${DB}/${table}?${filter}`, data, { headers: SB_HEADERS });
  return res.data;
}

const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "idle", booking: {} };
  return sessions[phone];
}

function getToday() { return new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function genOrderId() { return "FW-" + Math.floor(1000 + Math.random() * 9000); }

async function sendMessage(to, text) {
  await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendButtons(to, body, buttons) {
  await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "button", body: { text: body },
        action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function getCustomer(phone) {
  try { const rows = await dbSelect("customers", `phone=eq.${phone}`); return rows[0] || null; }
  catch { return null; }
}

async function saveCustomer(phone, name, address) {
  try {
    const existing = await getCustomer(phone);
    if (existing) await dbUpdate("customers", `phone=eq.${phone}`, { name, address });
    else await dbInsert("customers", { phone, name, address });
  } catch(e) { console.error("saveCustomer:", e.message); }
}

async function saveBooking(booking) {
  try {
    await dbInsert("bookings", {
      order_id: booking.orderId, name: booking.name, phone: booking.phone,
      address: booking.address, date: booking.date, slot: booking.slot, status: "pending"
    });
  } catch(e) { console.error("saveBooking:", e.message); }
}

async function askDate(phone) {
  await sendButtons(phone, "📅 Which day works for pickup?", [
    { id: "date_today", title: "Today" },
    { id: "date_tomorrow", title: "Tomorrow" },
    { id: "date_custom", title: "📆 Choose date" }
  ]);
}

async function askSlot(phone) {
  await sendButtons(phone, "🕐 Pick your time slot:", [
    { id: "slot_morning", title: "🌅 10 AM – 1 PM" },
    { id: "slot_evening", title: "🌆 5 PM – 8 PM" }
  ]);
}

async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  booking.orderId = orderId;
  booking.phone = phone;
  await saveBooking(booking);
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n` +
    `🆔 Order ID: *${orderId}*\n` +
    `👤 Name: ${booking.name}\n` +
    `📍 Address: ${booking.address}\n` +
    `📅 Date: ${booking.date}\n` +
    `🕐 Slot: ${booking.slot}\n\n` +
    `Our team will reach you before pickup. 💚\n` +
    `💰 Payment via UPI/Cash at pickup.`
  );
}

async function handleMessage(phone, text) {
  const session = getSession(phone);
  const t = text.toLowerCase().trim();

  if (session.step === "idle" && ["hi","hello","hey","hii","pickup","book","schedule","start","kapde","laundry","washing"].some(k => t.includes(k))) {
    const saved = await getCustomer(phone);
    if (saved && (t.includes("pickup") || t.includes("book") || t.includes("schedule") || t.includes("kapde") || t.includes("laundry"))) {
      session.step = "confirm_details"; session.booking = {};
      await sendButtons(phone, `Welcome back, ${saved.name}! 👋\n\nUse your saved details?\n📍 ${saved.address}`,
        [{ id: "use_saved", title: "✅ Yes, use these" }, { id: "update_details", title: "✏️ Update details" }]);
    } else if (saved) {
      session.step = "menu";
      await sendButtons(phone, `Hey ${saved.name}! 👋 Welcome back to Washkart!`,
        [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Pricing" }, { id: "btn_track", title: "🔍 Track Order" }]);
    } else {
      session.step = "get_address"; session.booking = {};
      await sendMessage(phone, "👋 Welcome to *Washkart Laundry*! 🧺\n\nLet's book your pickup.\n\nPlease send me your *pickup address*:");
    }
    return;
  }

  if (session.step === "menu") {
    if (text === "btn_book") { session.step = "idle"; await handleMessage(phone, "pickup"); }
    else if (text === "btn_price") await handleMessage(phone, "price");
    else if (text === "btn_track") await handleMessage(phone, "track");
    return;
  }

  if (session.step === "confirm_details") {
    if (text === "use_saved") {
      const saved = await getCustomer(phone);
      session.booking.name = saved.name; session.booking.address = saved.address;
      session.step = "select_date"; await askDate(phone);
    } else {
      session.booking = {}; session.step = "get_address";
      await sendMessage(phone, "📍 Please send me your new *pickup address*:");
    }
    return;
  }

  if (session.step === "get_address") { session.booking.address = text; session.step = "get_name"; await sendMessage(phone, "👤 What's your *name*?"); return; }
  if (session.step === "get_name") { session.booking.name = text; session.step = "select_date"; await saveCustomer(phone, text, session.booking.address); await askDate(phone); return; }

  if (session.step === "select_date") {
    if (text === "date_today") { session.booking.date = getToday(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_tomorrow") { session.booking.date = getTomorrow(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_custom") { session.step = "get_custom_date"; await sendMessage(phone, "📅 Please type your preferred date (e.g. *26 April*):"); }
    return;
  }

  if (session.step === "get_custom_date") { session.booking.date = text; session.step = "select_slot"; await askSlot(phone); return; }

  if (session.step === "select_slot") {
    if (text === "slot_morning") session.booking.slot = "Morning (10 AM – 1 PM)";
    else if (text === "slot_evening") session.booking.slot = "Evening (5 PM – 8 PM)";
    else { await askSlot(phone); return; }
    session.step = "idle";
    await confirmBooking(phone, session.booking);
    return;
  }

  if (t.includes("price") || t.includes("rate") || t.includes("cost") || t.includes("charge")) {
    await sendMessage(phone,
      "💰 *Washkart Laundry — Rates*\n\n" +
      "🔥 *Ironing*\n" +
      "Normal Iron — ₹10 | Urgent Iron — ₹20\n" +
      "Steam Iron — ₹20 | Kurta — ₹20\n" +
      "Shawl — ₹40 | Saree — ₹60\n" +
      "Anarkali — ₹20 | Lehenga — ₹100\n" +
      "Blazer — ₹100 | Bedhseet — ₹40\n" +
      "Saree Steam — ₹100 | Roll Press — ₹120\n\n" +
      "👔 *Dry Clean — Men*\n" +
      "Shirt/Trouser/Jeans/T-Shirt — ₹70\n" +
      "Kurta — ₹150 | Blazer — ₹250-300\n" +
      "Suit 2pc — ₹250 | Suit 3pc — ₹350\n" +
      "Sweater — ₹200 | Jacket — ₹200\n" +
      "Puffer Jacket — ₹250 | Leather Jacket — ₹350\n\n" +
      "👗 *Dry Clean — Women*\n" +
      "Blouse/Top/T-Shirt/Shirt — ₹70\n" +
      "Kurti — ₹90 | Skirt — ₹90\n" +
      "Saree — ₹300 | Saree Work — ₹400\n" +
      "Anarkali — ₹200 | Lehenga — ₹350\n" +
      "Dress — ₹150-200 | Dress Gown — ₹300\n" +
      "Sweater — ₹150 | Dupatta — ₹150\n\n" +
      "🏠 *Household*\n" +
      "Single Bedsheet — ₹120 | Double Bedsheet — ₹200\n" +
      "Single Blanket — ₹300 | Double Blanket — ₹400\n" +
      "Curtains — ₹10/pc | Towel Large — ₹100\n" +
      "Shawl — ₹150 | Hand Bag — ₹400\n\n" +
      "🫧 *Laundry / Washing*\n" +
      "Wash & Fold — ₹59 | Wash & Iron — ₹79\n" +
      "Bedsheet Wash — ₹100 | Blanket Wash — ₹150\n" +
      "Curtain Wash — ₹200 | Sofa Cover — ₹150\n\n" +
      "👟 *Shoe Cleaning*\n" +
      "Sneakers — ₹300 | Sports Shoes — ₹250\n" +
      "Leather Shoes — ₹400 | Slides — ₹200\n\n" +
      "⚠️ _Final rates may vary based on cloth quality & work_\n\n" +
      "Type *pickup* to book now! 🧺"
    );
    return;
  }

  if (t.includes("track") || t.includes("status") || t.includes("order")) {
    session.step = "tracking";
    await sendMessage(phone, "🔍 Share your *Order ID* (e.g. FW-1234):");
    return;
  }

  if (session.step === "tracking") {
    try {
      const rows = await dbSelect("bookings", `order_id=eq.${text.toUpperCase()}`);
      if (rows.length > 0) {
        const statusMap = { pending: "⏳ Pending pickup", picked: "🚗 Picked up — being washed", washing: "🫧 Washing in progress", delivered: "✅ Delivered!" };
        await sendMessage(phone, `*${rows[0].order_id}*: ${statusMap[rows[0].status] || rows[0].status}`);
      } else {
        await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
      }
    } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
    session.step = "idle"; return;
  }

  // Default fallback — start booking
  session.step = "idle";
  await handleMessage(phone, "pickup");
}

// Webhook verify
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", async (req, res) => {
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return res.sendStatus(200);
    const msg = messages[0];
    const phone = msg.from;
    let text = "";
    if (msg.type === "text") text = msg.text.body;
    else if (msg.type === "interactive") {
      text = msg.interactive.type === "button_reply"
        ? msg.interactive.button_reply.id
        : msg.interactive.list_reply.id;
    }
    if (text) await handleMessage(phone, text);
    res.sendStatus(200);
  } catch(err) { console.error(err?.response?.data || err.message); res.sendStatus(200); }
});

// Dashboard API endpoints
app.get("/bookings", async (req, res) => {
  try { res.json(await dbSelect("bookings", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/bookings/:orderId", async (req, res) => {
  try { await dbUpdate("bookings", `order_id=eq.${req.params.orderId}`, { status: req.body.status }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/customers", async (req, res) => {
  try { res.json(await dbSelect("customers", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart bot running on port ${PORT}`));
