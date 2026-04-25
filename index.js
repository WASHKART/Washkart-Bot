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

async function dbInsert(table, data) { return (await axios.post(`${DB}/${table}`, data, { headers: SB_HEADERS })).data; }
async function dbSelect(table, filter) { return (await axios.get(`${DB}/${table}?${filter}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(table, filter, data) { return (await axios.patch(`${DB}/${table}?${filter}`, data, { headers: SB_HEADERS })).data; }

const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "idle", booking: {} };
  return sessions[phone];
}
function getToday() { return new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function genOrderId() { return "FW-" + Math.floor(1000 + Math.random() * 9000); }

// ── KEYWORD MATCHING (case-insensitive) ──────────────────────────
function has(t, ...words) { return words.some(w => t.includes(w)); }

const BOOKING_WORDS = ["pickup","book","schedule","start","kapde","dhulai","collect","laundry pickup","washing pickup","dhobi","pickup karna","booking"];
const GREETING_WORDS = ["hi","hello","hey","hii","helo","namaste","kem cho","namaskar","good morning","good evening","good afternoon"];
const PRICE_WORDS = ["price","rate","rates","cost","charge","kitna","kitne","paisa","how much","rate list","pricing","charges","tarrif","tariff"];
const TRACK_WORDS = ["track","status","order","where","mera order","kahan","kab","delivery","when"];
const IRON_WORDS = ["iron","ironing","press","pressing","istr","istri","kapde press"];
const DRYCLEAN_WORDS = ["dry clean","dryclean","dry-clean","drycleaning","dry cleaning","dc"];
const WASH_WORDS = ["wash","laundry","washing","dhona","dhulai","fold","wash fold","wash iron"];
const SHOE_WORDS = ["shoe","shoes","sneaker","boot","chappal","sandal","footwear","juta"];

// Specific item keywords for smart pricing
const ITEM_PRICES = {
  // Iron
  "normal iron": "Normal Iron — ₹10/pc", "urgent iron": "Urgent Iron — ₹20/pc",
  "steam iron": "Steam Iron — ₹20/pc", "kurta iron": "Kurta Iron — ₹20/pc",
  "shawl iron": "Shawl Iron — ₹40/pc", "saree iron": "Saree Iron — ₹60/pc",
  "anarkali iron": "Anarkali Iron — ₹20/pc", "lehenga iron": "Lehenga Iron — ₹100/pc",
  "blazer iron": "Blazer Iron — ₹100/pc", "bedsheet iron": "Bedsheet Iron — ₹40/pc",
  "roll press": "Roll Press — ₹120/pc",
  // Men DC
  "shirt dry": "Shirt Dry Clean — ₹70", "trouser dry": "Trouser Dry Clean — ₹70",
  "jeans dry": "Jeans Dry Clean — ₹70", "tshirt dry": "T-Shirt Dry Clean — ₹70",
  "suit 2": "Suit 2pc Dry Clean — ₹250", "suit 3": "Suit 3pc Dry Clean — ₹350",
  "blazer dry": "Blazer Dry Clean — ₹250-300", "jacket dry": "Jacket Dry Clean — ₹200",
  "sweater dry": "Sweater Dry Clean — ₹200", "leather jacket": "Leather Jacket — ₹350",
  "kurta dry": "Kurta Dry Clean — ₹150",
  // Women DC
  "saree dry": "Saree Dry Clean — ₹300", "saree work": "Saree Work Dry Clean — ₹400",
  "saree silk": "Saree Silk Dry Clean — ₹350", "blouse dry": "Blouse Dry Clean — ₹70",
  "anarkali dry": "Anarkali Dry Clean — ₹200", "lehenga dry": "Lehenga Dry Clean — ₹350",
  "lehenga heavy": "Lehenga Heavy Dry Clean — ₹450", "dress dry": "Dress Dry Clean — ₹150-200",
  "kurti dry": "Kurti Dry Clean — ₹90", "dupatta dry": "Dupatta Dry Clean — ₹150",
  // Laundry
  "wash fold": "Wash & Fold — ₹59", "wash iron": "Wash & Iron — ₹79",
  "bedsheet wash": "Bedsheet Wash — ₹100", "blanket wash": "Blanket Wash — ₹150",
  "curtain wash": "Curtain Wash — ₹200", "sofa cover": "Sofa Cover Wash — ₹150",
  // Shoes
  "sneaker": "Sneakers Cleaning — ₹300", "leather shoe": "Leather Shoes Cleaning — ₹400",
  "slide": "Slides Cleaning — ₹200", "sports shoe": "Sports Shoes Cleaning — ₹250",
};

const RATES = {
  iron:
    "🔥 *Ironing Rates*\n\n" +
    "Normal Iron — ₹10 | Urgent Iron — ₹20\n" +
    "Steam Iron — ₹20 | Kurta Iron — ₹20\n" +
    "Shawl Iron — ₹40 | Saree Iron — ₹60\n" +
    "Anarkali — ₹20 | Lehenga — ₹100\n" +
    "Blazer — ₹100 | Bedsheet — ₹40\n" +
    "Saree Steam — ₹100 | Roll Press — ₹120\n\n" +
    "⚠️ _Rates may vary based on cloth quality_",

  dryclean:
    "🧥 *Dry Clean Rates*\n\n" +
    "👔 *Men*\n" +
    "Shirt/Trouser/Jeans/T-Shirt — ₹70\n" +
    "Kurta — ₹150 | Tie — ₹70\n" +
    "Blazer — ₹250-300 | Nawabi — ₹350\n" +
    "Suit 2pc — ₹250 | Suit 3pc — ₹350\n" +
    "Sweater — ₹200 | Vest Coat — ₹150\n" +
    "Jacket — ₹200 | Puffer Jacket — ₹250\n" +
    "Leather Jacket — ₹350 | Jodhpuri — ₹300\n\n" +
    "👗 *Women*\n" +
    "Blouse/Top/T-Shirt/Shirt — ₹70\n" +
    "Kurti — ₹90 | Skirt — ₹90 | Legging — ₹70\n" +
    "Saree — ₹300 | Saree Work — ₹400 | Saree Silk — ₹350\n" +
    "Anarkali — ₹200 | Lehenga — ₹350 | Lehenga Heavy — ₹450\n" +
    "Dress — ₹150 | Dress Evening — ₹200 | Dress Gown — ₹300\n" +
    "Sweater — ₹150 | Dupatta — ₹150 | Plazo — ₹100\n" +
    "Scarf — ₹100 | Night Wear — ₹150 | Dhoti — ₹150\n\n" +
    "🏠 *Household Dry Clean*\n" +
    "Curtains — ₹10/pc | Sack Bag — ₹300\n" +
    "Hand Bag — ₹400 | Shawl — ₹150\n" +
    "Single Blanket — ₹300 | Double Blanket — ₹400\n" +
    "Table Cloth — ₹80 | Towel Large — ₹100\n\n" +
    "⚠️ _Rates may vary based on cloth quality & work_",

  laundry:
    "🫧 *Laundry / Washing Rates*\n\n" +
    "Wash & Fold — ₹59\n" +
    "Wash & Iron — ₹79\n" +
    "Bedsheet Wash — ₹100\n" +
    "Blanket Wash — ₹150\n" +
    "Curtain Wash — ₹200\n" +
    "Sofa Cover — ₹150\n" +
    "Carpet — ₹250\n\n" +
    "⚠️ _Rates may vary based on cloth quality_",

  shoes:
    "👟 *Shoe Cleaning Rates*\n\n" +
    "Sneakers — ₹300\n" +
    "Leather Shoes — ₹400\n" +
    "Slides — ₹200\n" +
    "Sports Shoes — ₹250\n\n" +
    "⚠️ _Rates may vary based on condition_",
};

// ── SEND HELPERS ─────────────────────────────────────────────────
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

// ── DB HELPERS ───────────────────────────────────────────────────
async function getCustomer(phone) {
  try { const r = await dbSelect("customers", `phone=eq.${phone}`); return r[0] || null; } catch { return null; }
}
async function saveCustomer(phone, name, address) {
  try {
    const ex = await getCustomer(phone);
    if (ex) await dbUpdate("customers", `phone=eq.${phone}`, { name, address });
    else await dbInsert("customers", { phone, name, address });
  } catch(e) { console.error("saveCustomer:", e.message); }
}
async function saveBooking(booking) {
  try {
    await dbInsert("bookings", { order_id: booking.orderId, name: booking.name, phone: booking.phone, address: booking.address, date: booking.date, slot: booking.slot, status: "pending" });
  } catch(e) { console.error("saveBooking:", e.message); }
}

// ── FLOW HELPERS ─────────────────────────────────────────────────
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
async function askPriceCategory(phone) {
  await sendButtons(phone, "💰 Which service rates would you like to see?",
    [{ id: "price_iron", title: "🔥 Ironing" }, { id: "price_dc", title: "🧥 Dry Clean" }, { id: "price_wash", title: "🫧 Laundry/Wash" }]
  );
  // Send shoe as separate message since max 3 buttons
  setTimeout(async () => {
    await sendButtons(phone, "More categories:",
      [{ id: "price_shoe", title: "👟 Shoe Cleaning" }, { id: "price_all", title: "📋 All Rates" }, { id: "btn_book", title: "📦 Book Pickup" }]
    );
  }, 500);
}
async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  booking.orderId = orderId; booking.phone = phone;
  await saveBooking(booking);
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n` +
    `🆔 Order ID: *${orderId}*\n` +
    `👤 Name: ${booking.name}\n` +
    `📍 Address: ${booking.address}\n` +
    `📅 Date: ${booking.date}\n` +
    `🕐 Slot: ${booking.slot}\n\n` +
    `Our team will reach you before pickup. 💚\n` +
    `💰 Payment via UPI/Cash at pickup.\n\n` +
    `Type *track* + your Order ID anytime to check status.`
  );
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
async function handleMessage(phone, text) {
  const session = getSession(phone);
  const t = text.toLowerCase().trim();

  // ── Price category button replies ──
  if (text === "price_iron") { await sendMessage(phone, RATES.iron); return; }
  if (text === "price_dc") { await sendMessage(phone, RATES.dryclean); return; }
  if (text === "price_wash") { await sendMessage(phone, RATES.laundry); return; }
  if (text === "price_shoe") { await sendMessage(phone, RATES.shoes); return; }
  if (text === "price_all") {
    await sendMessage(phone, RATES.iron);
    setTimeout(() => sendMessage(phone, RATES.dryclean), 600);
    setTimeout(() => sendMessage(phone, RATES.laundry), 1200);
    setTimeout(() => sendMessage(phone, RATES.shoes), 1800);
    return;
  }

  // ── Smart specific item price query ──
  // e.g. "saree dry clean rate", "sneaker rate", "blazer iron price"
  if (has(t, ...PRICE_WORDS) || has(t, "rate","price","kitna","how much")) {
    for (const [keyword, reply] of Object.entries(ITEM_PRICES)) {
      if (t.includes(keyword)) {
        await sendMessage(phone, `💰 *${reply}*\n\n⚠️ _Final rate may vary based on cloth quality & work_\n\nType *pickup* to book now! 🧺`);
        return;
      }
    }
    // Category-specific rate requests
    if (has(t, ...IRON_WORDS)) { await sendMessage(phone, RATES.iron); return; }
    if (has(t, ...DRYCLEAN_WORDS)) { await sendMessage(phone, RATES.dryclean); return; }
    if (has(t, ...WASH_WORDS)) { await sendMessage(phone, RATES.laundry); return; }
    if (has(t, ...SHOE_WORDS)) { await sendMessage(phone, RATES.shoes); return; }
    // General price query — ask category
    session.step = "price_category";
    await askPriceCategory(phone);
    return;
  }

  // ── Greetings + booking triggers ──
  if (session.step === "idle") {
    const isGreeting = has(t, ...GREETING_WORDS);
    const isBooking = has(t, ...BOOKING_WORDS);

    if (isBooking) {
      const saved = await getCustomer(phone);
      if (saved) {
        session.step = "confirm_details"; session.booking = {};
        await sendButtons(phone, `Welcome back, ${saved.name}! 👋\n\nUse your saved details?\n📍 ${saved.address}`,
          [{ id: "use_saved", title: "✅ Yes, use these" }, { id: "update_details", title: "✏️ Update details" }]);
      } else {
        session.step = "get_address"; session.booking = {};
        await sendMessage(phone, "👋 Welcome to *Washkart Laundry*! 🧺\n\nLet's book your pickup.\n\nPlease send me your *pickup address*:");
      }
      return;
    }

    if (isGreeting) {
      const saved = await getCustomer(phone);
      session.step = "menu";
      const name = saved ? saved.name : "there";
      await sendButtons(phone, `Hey ${name}! 👋 Welcome to *Washkart Laundry*! 🧺\n\nHow can I help you?`,
        [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]);
      return;
    }
  }

  // ── Menu button replies ──
  if (text === "btn_book") { session.step = "idle"; await handleMessage(phone, "pickup"); return; }
  if (text === "btn_price") { session.step = "price_category"; await askPriceCategory(phone); return; }
  if (text === "btn_track") { session.step = "tracking"; await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):"); return; }

  // ── Booking flow ──
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
  if (session.step === "get_name") { session.booking.name = text; await saveCustomer(phone, text, session.booking.address); session.step = "select_date"; await askDate(phone); return; }
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

  // ── Tracking ──
  if (has(t, ...TRACK_WORDS) && session.step !== "tracking") {
    session.step = "tracking";
    await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):");
    return;
  }
  if (session.step === "tracking") {
    try {
      const rows = await dbSelect("bookings", `order_id=eq.${text.toUpperCase()}`);
      if (rows.length > 0) {
        const statusMap = { pending: "⏳ Pending pickup", picked: "🚗 Picked up — being washed", washing: "🫧 Washing in progress", delivered: "✅ Delivered!" };
        await sendMessage(phone, `*${rows[0].order_id}* status: ${statusMap[rows[0].status] || rows[0].status}`);
      } else {
        await sendMessage(phone, "❌ Order not found. Please check the Order ID and try again.");
      }
    } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
    session.step = "idle"; return;
  }

  // ── Fallback — treat as booking intent ──
  session.step = "idle";
  await sendButtons(phone, "Hi! 👋 How can I help you?",
    [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]);
  session.step = "menu";
}

// ── WEBHOOK ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

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

// ── DASHBOARD API ─────────────────────────────────────────────────
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
