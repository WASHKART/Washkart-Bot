const express = require("express");
const axios = require("axios");
const path = require("path");
const app = express();
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────────
const TOKEN = "EAAST7Y5o9b0BRW88SOTRQqT2hJy62MgMRoTt0509KkEiRT8O74pSoOP8bmZBKTbfGEW8PhjIej3EP7JVZB1LKyM1ZCUGOwUeYck6HJbmDYviMWCKMPLLpA776ooDpTDWqMB5H2mnGhz635T7c31OxKGb7uQ4ZCZCrirw9ROQ2LIKRvq6GMGcAQqa1tQQxfsq2IwZDZD";
const PHONE_NUMBER_ID = "1119391667920272";
const VERIFY_TOKEN = "washkart_verify_123";
const ADMIN_NUMBER = "917775066002";
const SUPABASE_URL = "https://uausvybpqawxlayyqxlf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhdXN2eWJwcWF3eGxheXlxeGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMjE3NzYsImV4cCI6MjA5MjU5Nzc3Nn0.GWqlExeEX1VHAPFQ_YBJrFsOSFb5RS_ZZdxkDTMjjCM";
const DB = `${SUPABASE_URL}/rest/v1`;
const SB_HEADERS = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

// ── DB ───────────────────────────────────────────────────────────
async function dbInsert(t, d) { return (await axios.post(`${DB}/${t}`, d, { headers: SB_HEADERS })).data; }
async function dbSelect(t, f) { return (await axios.get(`${DB}/${t}?${f}`, { headers: SB_HEADERS })).data; }
async function dbUpdate(t, f, d) { return (await axios.patch(`${DB}/${t}?${f}`, d, { headers: SB_HEADERS })).data; }

// ── SESSIONS & DEDUP ─────────────────────────────────────────────
const sessions = {};
const processedMessages = new Set();
function getSession(p) {
  if (!sessions[p]) sessions[p] = { step: "idle", booking: {} };
  return sessions[p];
}

// ── UTILS ────────────────────────────────────────────────────────
function getToday() { return new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function genOrderId() { return "FW-" + Math.floor(1000 + Math.random() * 9000); }
function has(t, ...words) { return words.some(w => t.includes(w)); }
function normalize(t) { return t.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " "); }

// ── STATUS CONFIG ────────────────────────────────────────────────
const STATUS_MAP = {
  pending:         { label: "⏳ Pending pickup",      eta: "Our team will pick up within your selected slot." },
  picked:          { label: "🚗 Picked up",            eta: "Clothes picked up! Cleaning in progress soon." },
  inprogress:      { label: "🫧 In Progress",          eta: "Your clothes are being cleaned. Usually takes 24-48 hrs." },
  outfordelivery:  { label: "🚚 Out for Delivery",     eta: "Your clothes are on the way! Expected within a few hours." },
  delivered:       { label: "✅ Delivered",            eta: "Your clothes have been delivered. Thank you! 🙏" },
  cancelled:       { label: "❌ Cancelled",            eta: "This order was cancelled." },
};

const STATUS_UPDATES = {
  picked:         "🚗 *Your clothes have been picked up!*\n\nWe'll start cleaning them right away. You'll get updates as we go. 💚",
  inprogress:     "🫧 *Your clothes are being cleaned!*\n\nSit back and relax — we're taking good care of them. ✨",
  outfordelivery: "🚚 *Your order is out for delivery!*\n\nExpect your fresh clothes within a few hours. 😊",
  delivered:      "✅ *Your clothes have been delivered!*\n\nThank you for choosing Washkart! 🙏\n\nHow was your experience? Reply with ⭐ to ⭐⭐⭐⭐⭐",
};

// ── KEYWORDS ─────────────────────────────────────────────────────
const BOOKING_KW   = ["pickup","book","schedule","start","kapde","dhulai","collect","dhobi","booking","pickup karna","mera kapda","laundry book","wash book","pickup chahiye","pickup karo","pickup karna hai","schedule karo","book karna","book karo","order karna","order karo","seva","service book"];
const GREET_KW     = ["hi","hello","hey","hii","helo","namaste","kem cho","namaskar","good morning","good evening","good afternoon","wassup","sup","hola","jai shree","radhe radhe","sat sri akal"];
const PRICE_KW     = [
  // English
  "price","rate","rates","cost","charge","how much","rate list","pricing","charges","tariff","fee","fees",
  "price list","rate card","how much for","what's the cost","tell me the price","give me rates","show rates",
  "how much does","what do you charge","charges for","cost of","price of","price for","how much is",
  "what is the rate","what are the rates","what is the price","what is the charge",
  // Hindi/Hinglish
  "kitna","kitne","paisa","kitna lagega","kitne mein","kitna paisa","kitne ka","kitna hoga",
  "bata do","bolo bhai","kya rate hai","rate kya hai","price kya hai","kya charge hai",
  "charge kya hai","kya lagega","lagega kitna","batao","bolo","kya hai","kiti","rupaye",
  // Marathi
  "kiti rupaye","kiti paisa","kiti lagel","sangaa","saanga","kitee","dar","dara kaay ahe",
];
const TRACK_KW     = [
  "track","status","order","where","mera order","kahan","kab","delivery","when",
  "kab aayega","kab milega","order status","check order","my order","order kahan",
  "kapde kahan","kab ayega","delivery kab","kitna time","kitna time lagega","kab tak",
  "time lagega","kitna waqt","delivery time","kab deliver","kab milenge","order track",
  "abhi kahan","kitna time baki","eta","when will","when is my","where is my",
  "how long","how much time","order abhi kahan hai","mera kapda kahan",
  // Marathi
  "kiti vel lagel","keva milel","order kuthe","delivery keva"
];
const CANCEL_KW    = ["cancel","cancellation","band karo","nahi chahiye","cancel karo","booking cancel","order cancel","raddh karo","cancel karna"];
const IRON_KW      = ["iron","ironing","press","pressing","istri","istr","kapde press","steam","steam press","ironing rate","press rate","istri rate"];
const DC_KW        = ["dry clean","dryclean","dry-clean","drycleaning","dry cleaning","dc","chemical clean","chemical wash"];
const WASH_KW      = ["wash","laundry","washing","dhona","dhulai","fold","wash fold","wash iron","machine wash","laundry wash","dhulai rate","washing rate"];
const SHOE_KW      = ["shoe","shoes","sneaker","sneakers","boot","boots","chappal","sandal","footwear","juta","joote","sports shoe","leather shoe","shoe clean","shoe wash"];
const HOUSEHOLD_KW = ["bedsheet","blanket","curtain","sofa","carpet","bed sheet","sofa cover","ghar","household","home","chadar","razai","parda","rajai"];
const FEEDBACK_KW  = ["⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐","1","2","3","4","5","good","great","excellent","bad","poor","average","ok","okay","👍","👎","bahut accha","accha","theek","bekar","best","worst"];
const TIME_KW      = ["kitna time","time lagega","kab tak","kab aayega","kab milega","kitna waqt","how long","when will","delivery time","eta","kiti vel","keva milel","kab deliver","kab milenge","time","lagega","waqt"];

// ── ITEM PRICE MAP ───────────────────────────────────────────────
const ITEM_MAP = [
  [["normal iron","sada iron","simple iron","normal press","plain iron"], "Normal Iron — ₹10/pc"],
  [["urgent iron","express iron","jaldi iron","fast iron","urgent press"], "Urgent Iron — ₹20/pc"],
  [["steam iron","bhap","steam press","bhap wali istri"], "Steam Iron — ₹20/pc"],
  [["kurta iron","kurta press","kurti iron","kurti press"], "Kurta/Kurti Iron — ₹20/pc"],
  [["shawl iron","shawl press","dupatta iron","dupatta press","stole iron"], "Shawl/Dupatta Iron — ₹40/pc"],
  [["saree iron","saree press","sari iron","sari press","saree istri"], "Saree Iron — ₹60/pc"],
  [["anarkali iron","anarkali press"], "Anarkali Iron — ₹20/pc"],
  [["lehenga iron","lehnga iron","lehenga press","lehnga press"], "Lehenga Iron — ₹100/pc"],
  [["blazer iron","blazer press","coat iron","coat press","jacket iron"], "Blazer/Coat Iron — ₹100/pc"],
  [["bedsheet iron","bed sheet iron","chadar iron","bedsheet press"], "Bedsheet Iron — ₹40/pc"],
  [["roll press","roll iron","trouser press"], "Roll Press — ₹120/pc"],
  [["shirt iron","shirt press"], "Shirt Iron — ₹20/pc"],
  [["pant iron","trouser iron","pant press"], "Pant/Trouser Iron — ₹20/pc"],
  // Dry Clean Men
  [["shirt dry","shirt clean","shirt dc","shirt dryclean"], "Shirt Dry Clean — ₹70"],
  [["trouser dry","pant dry","trouser clean","pant clean","pant dc"], "Trouser/Pant Dry Clean — ₹70"],
  [["jeans dry","jeans clean","jeans dc","jeans dryclean"], "Jeans Dry Clean — ₹70"],
  [["tshirt dry","t shirt dry","t-shirt dry","tshirt clean","t shirt clean"], "T-Shirt Dry Clean — ₹70"],
  [["kurta dry","kurta clean","kurta dc","kurta dryclean"], "Kurta Dry Clean — ₹150"],
  [["suit 2","suit two","2 piece","2pc suit","two piece"], "Suit 2pc Dry Clean — ₹250"],
  [["suit 3","suit three","3 piece","3pc suit","three piece"], "Suit 3pc Dry Clean — ₹350"],
  [["blazer dry","blazer clean","blazer dc","coat dry","coat clean"], "Blazer Dry Clean — ₹250–300"],
  [["jacket dry","jacket clean","jacket dc","jacket dryclean"], "Jacket Dry Clean — ₹200"],
  [["puffer jacket","puffer dry","winter jacket","winter coat"], "Puffer Jacket Dry Clean — ₹250"],
  [["leather jacket","leather coat","leather dry"], "Leather Jacket Dry Clean — ₹350"],
  [["sweater dry","sweater clean","woolen dry","sweatshirt dry","sweater dc"], "Sweater Dry Clean — ₹200"],
  [["jodhpuri dry","jodhpuri clean","sherwani dry","sherwani clean"], "Jodhpuri/Sherwani Dry Clean — ₹300"],
  [["nawabi","nawab suit","nawab dry"], "Nawabi Suit Dry Clean — ₹350"],
  [["vest coat","waistcoat dry","vest dry"], "Vest Coat Dry Clean — ₹150"],
  // Dry Clean Women
  [["saree dry","saree clean","saree dc","sari dry","sari clean","saree dryclean","sari dryclean"], "Saree Dry Clean — ₹300"],
  [["saree work","work saree","embroidery saree","designer saree","designer sari","heavy saree"], "Saree Work Dry Clean — ₹400"],
  [["saree silk","silk saree","silk sari","pure silk saree"], "Saree Silk Dry Clean — ₹350"],
  [["blouse dry","blouse clean","blouse dc","blouse dryclean"], "Blouse Dry Clean — ₹70"],
  [["anarkali dry","anarkali clean","anarkali dc"], "Anarkali Dry Clean — ₹200"],
  [["lehenga dry","lehenga clean","lehnga dry","lehnga clean","lehenga dc"], "Lehenga Dry Clean — ₹350"],
  [["lehenga heavy","heavy lehenga","bridal lehenga","wedding lehenga","bridal lehnga"], "Lehenga Heavy Dry Clean — ₹450"],
  [["dress dry","dress clean","frock dry","frock clean","dress dc"], "Dress Dry Clean — ₹150–200"],
  [["dress gown","gown dry","gown clean","evening gown","gown dc"], "Dress Gown Dry Clean — ₹300"],
  [["kurti dry","kurti clean","kurti dc","kurti dryclean"], "Kurti Dry Clean — ₹90"],
  [["dupatta dry","dupatta clean","chunni dry","chunni clean"], "Dupatta Dry Clean — ₹150"],
  [["skirt dry","skirt clean","skirt dc"], "Skirt Dry Clean — ₹90"],
  [["plazo dry","palazzo dry","plazo clean","palazzo clean"], "Plazo Dry Clean — ₹100"],
  [["scarf dry","scarf clean","muffler dry","stole dry"], "Scarf/Stole Dry Clean — ₹100"],
  [["night wear","nightwear","nighty dry","nighty clean","night suit dry"], "Night Wear Dry Clean — ₹150"],
  [["dhoti dry","dhoti clean","dhoti dc"], "Dhoti Dry Clean — ₹150"],
  [["legging dry","legging clean","legging dc"], "Legging Dry Clean — ₹70"],
  [["top dry","top clean","top dc"], "Top Dry Clean — ₹70"],
  [["pyjama dry","pyjama clean","pajama dry"], "Pyjama Dry Clean — ₹70"],
  // Household
  [["single bedsheet","single bed sheet","single chadar","1 bedsheet","ek bedsheet"], "Bedsheet Wash — ₹120/kg"],
  [["double bedsheet","double bed sheet","double chadar","2 bedsheet","do bedsheet"], "Bedsheet Wash — ₹120/kg"],
  [["blanket wash","razai wash","rajai wash","blanket clean","razai clean"], "Blanket Wash — ₹250/kg"],
  [["curtain wash","parda wash","curtain clean","parda clean","curtain dhona"], "Curtain Wash — ₹300/kg"],
  [["sofa cover","sofa wash","sofa clean","sofa dhona"], "Sofa Cover Wash — ₹150/kg"],
  [["carpet wash","carpet clean","carpet dhona","dhari wash","dari wash"], "Carpet Wash — ₹300/kg"],
  // Laundry
  [["wash fold","washing fold","fold wash","dhona fold","wash and fold"], "Wash & Fold — ₹59/kg (min 1kg)"],
  [["wash iron","washing iron","iron wash","dhona press","wash and iron","wash & iron"], "Wash & Iron — ₹79/kg (min 1kg)"],
  // Shoes
  [["sneaker","sneakers","canvas shoe","white shoe","converse","keds"], "Sneakers Cleaning — ₹300/pair"],
  [["leather shoe","formal shoe","oxford","bata shoe","formal boot"], "Leather Shoes Cleaning — ₹400/pair"],
  [["slide","slides","slipper clean","chappal clean","hawai chappal"], "Slides Cleaning — ₹200/pair"],
  [["sports shoe","running shoe","gym shoe","nike shoe","adidas shoe","puma shoe"], "Sports Shoes Cleaning — ₹250/pair"],
];

// ── RATES ────────────────────────────────────────────────────────
const RATES = {
  iron:
    "🔥 *Ironing Rates*\n\n" +
    "Normal Iron — ₹10 | Urgent Iron — ₹20\n" +
    "Steam Iron — ₹20 | Kurta/Kurti — ₹20\n" +
    "Shirt/Pant — ₹20 | Shawl/Dupatta — ₹40\n" +
    "Saree — ₹60 | Anarkali — ₹20\n" +
    "Lehenga — ₹100 | Blazer/Coat — ₹100\n" +
    "Bedsheet — ₹40 | Saree Steam — ₹100\n" +
    "Roll Press — ₹120\n\n" +
    "⚠️ _Rates may vary based on cloth quality_",

  dryclean:
    "🧥 *Dry Clean Rates*\n\n" +
    "👔 *Men*\n" +
    "Shirt/Trouser/Jeans/T-Shirt — ₹70\n" +
    "Kurta — ₹150 | Tie — ₹70\n" +
    "Blazer — ₹250–300 | Nawabi — ₹350\n" +
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
    "🏠 *Household*\n" +
    "Curtains — ₹10/pc | Sack Bag — ₹300\n" +
    "Hand Bag — ₹400 | Shawl — ₹150\n" +
    "Single Blanket — ₹300 | Double Blanket — ₹400\n" +
    "Table Cloth — ₹80 | Towel Large — ₹100\n\n" +
    "⚠️ _Rates may vary based on cloth quality & work_",

  laundry:
    "🫧 *Laundry / Washing Rates*\n\n" +
    "Wash & Fold — ₹59/kg\n" +
    "Wash & Iron — ₹79/kg\n" +
    "Bedsheet Wash — ₹120/kg\n" +
    "Blanket Wash — ₹250/kg\n" +
    "Curtain Wash — ₹300/kg\n" +
    "Sofa Cover — ₹150/kg\n" +
    "Carpet — ₹300/kg\n\n" +
    "📦 Minimum 1kg\n" +
    "🚚 Free pickup & delivery above ₹300\n\n" +
    "⚠️ _Rates may vary based on cloth quality_",

  shoes:
    "👟 *Shoe Cleaning Rates*\n\n" +
    "Sneakers — ₹300/pair\n" +
    "Leather Shoes — ₹400/pair\n" +
    "Slides — ₹200/pair\n" +
    "Sports Shoes — ₹250/pair\n\n" +
    "⚠️ _Rates may vary based on condition_",
};

// ── WHATSAPP SEND ────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch(e) { console.error("sendMessage error:", e?.response?.data || e.message); }
}
async function sendButtons(to, body, buttons) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "interactive",
        interactive: { type: "button", body: { text: body },
          action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch(e) { console.error("sendButtons error:", e?.response?.data || e.message); }
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
    await dbInsert("bookings", {
      order_id: booking.orderId, name: booking.name, phone: booking.phone,
      address: booking.address, date: booking.date, slot: booking.slot,
      status: "pending", reminder_sent: false
    });
  } catch(e) { console.error("saveBooking:", e.message); }
}
async function getActiveOrder(phone) {
  try {
    const rows = await dbSelect("bookings", `phone=eq.${phone}&status=neq.delivered&status=neq.cancelled&order=created_at.desc&limit=1`);
    return rows[0] || null;
  } catch { return null; }
}

// ── ADMIN NOTIFICATION ───────────────────────────────────────────
async function notifyAdmin(booking) {
  await sendMessage(ADMIN_NUMBER,
    `🔔 *New Booking!*\n\n` +
    `🆔 ${booking.orderId}\n` +
    `👤 ${booking.name}\n` +
    `📱 ${booking.phone}\n` +
    `📍 ${booking.address}\n` +
    `📅 ${booking.date}\n` +
    `🕐 ${booking.slot}`
  );
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
  await sendButtons(phone, "💰 Which service rates would you like?",
    [{ id: "price_iron", title: "🔥 Ironing" }, { id: "price_dc", title: "🧥 Dry Clean" }, { id: "price_wash", title: "🫧 Laundry/Wash" }]
  );
  setTimeout(async () => {
    await sendButtons(phone, "More categories:",
      [{ id: "price_shoe", title: "👟 Shoe Cleaning" }, { id: "price_all", title: "📋 All Rates" }, { id: "btn_book", title: "📦 Book Pickup" }]
    );
  }, 600);
}
async function confirmBooking(phone, booking) {
  const orderId = genOrderId();
  booking.orderId = orderId; booking.phone = phone;
  await saveBooking(booking);
  await sendMessage(phone,
    `✅ *Booking Confirmed!*\n\n` +
    `🆔 Order ID: *${orderId}*\n` +
    `👤 ${booking.name}\n` +
    `📍 ${booking.address}\n` +
    `📅 ${booking.date}\n` +
    `🕐 ${booking.slot}\n\n` +
    `Our team will arrive within your selected slot. 💚\n` +
    `💰 Payment via UPI/Cash at delivery.\n\n` +
    `To cancel: type *cancel ${orderId}*`
  );
  await notifyAdmin(booking);
}

// ── SMART PRICE LOOKUP ───────────────────────────────────────────
function smartPriceLookup(t) {
  for (const [keywords, reply] of ITEM_MAP) {
    if (keywords.some(k => t.includes(k))) return reply;
  }
  return null;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
async function handleMessage(phone, rawText) {
  const session = getSession(phone);
  const t = normalize(rawText);
  const text = rawText;

  // ── Price category buttons ──
  if (text === "price_iron")  { await sendMessage(phone, RATES.iron); return; }
  if (text === "price_dc")    { await sendMessage(phone, RATES.dryclean); return; }
  if (text === "price_wash")  { await sendMessage(phone, RATES.laundry); return; }
  if (text === "price_shoe")  { await sendMessage(phone, RATES.shoes); return; }
  if (text === "price_all")   {
    await sendMessage(phone, RATES.iron);
    setTimeout(() => sendMessage(phone, RATES.dryclean), 700);
    setTimeout(() => sendMessage(phone, RATES.laundry), 1400);
    setTimeout(() => sendMessage(phone, RATES.shoes), 2100);
    return;
  }

  // ── Feedback (after delivery) ──
  if (has(t, ...FEEDBACK_KW) && session.step === "feedback") {
    const stars = (t.match(/⭐/g) || []).length || parseInt(t) || 0;
    const msg = stars >= 4
      ? `Thank you for the ${stars}⭐ rating! We're thrilled you're happy. See you next time! 🙏`
      : stars > 0
        ? `Thank you for your feedback! We'll work on improving. 🙏`
        : `Thank you for your feedback! 🙏`;
    await sendMessage(phone, msg);
    session.step = "idle";
    return;
  }

  // ── Cancellation ──
  if (has(t, ...CANCEL_KW)) {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0 && rows[0].phone === phone) {
          if (["delivered","cancelled"].includes(rows[0].status)) {
            await sendMessage(phone, `❌ Order *${orderId}* cannot be cancelled (${STATUS_MAP[rows[0].status]?.label}).`);
          } else {
            await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
            await sendMessage(phone, `✅ Order *${orderId}* cancelled successfully.\n\nType *pickup* to book again anytime! 🧺`);
            await sendMessage(ADMIN_NUMBER, `❌ *Booking Cancelled*\n\n🆔 ${orderId}\n👤 ${rows[0].name}\n📅 ${rows[0].date}\n🕐 ${rows[0].slot}`);
          }
        } else {
          // Try to find their active order
          const active = await getActiveOrder(phone);
          if (active) {
            await sendButtons(phone, `Cancel your active order *${active.order_id}*?`,
              [{ id: `confirm_cancel_${active.order_id}`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ No, Keep it" }]);
            session.step = "confirm_cancel";
          } else {
            await sendMessage(phone, `❌ No active order found. Type *pickup* to book! 🧺`);
          }
        }
      } catch { await sendMessage(phone, "Sorry, couldn't process. Try again."); }
      session.step = "idle";
      return;
    } else {
      // No order ID — try to find active order
      const active = await getActiveOrder(phone);
      if (active) {
        await sendButtons(phone,
          `Cancel your active order?\n\n🆔 ${active.order_id}\n📅 ${active.date} | 🕐 ${active.slot}`,
          [{ id: `confirm_cancel_${active.order_id}`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ No, Keep it" }]
        );
        session.step = "confirm_cancel";
      } else {
        await sendMessage(phone, "No active orders found. Type *pickup* to book! 🧺");
      }
      return;
    }
  }

  // ── Cancel confirmation buttons ──
  if (session.step === "confirm_cancel") {
    if (text.startsWith("confirm_cancel_")) {
      const orderId = text.replace("confirm_cancel_", "");
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
      await sendMessage(phone, `✅ Order *${orderId}* cancelled. Type *pickup* to book again! 🧺`);
      await sendMessage(ADMIN_NUMBER, `❌ *Booking Cancelled*\n\n🆔 ${orderId}`);
    } else {
      await sendMessage(phone, "Got it! Your order is still active. 👍");
    }
    session.step = "idle"; return;
  }

  // ── Tracking ──
  if (has(t, ...TRACK_KW) || has(t, ...TIME_KW)) {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      // Direct order ID provided
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
          await sendMessage(phone, `*${orderId}* — ${s.label}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      return;
    }
    // No order ID — check active order
    const active = await getActiveOrder(phone);
    if (active) {
      const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
      await sendMessage(phone,
        `📦 *Your Active Order*\n\n` +
        `🆔 ${active.order_id}\n` +
        `${s.label}\n` +
        `📅 ${active.date} | 🕐 ${active.slot}\n\n` +
        `${s.eta}`
      );
      return;
    }
    // No active order — ask
    if (session.step !== "tracking") {
      session.step = "tracking";
      await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):"); return;
    }
  }

  if (session.step === "tracking") {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
          await sendMessage(phone, `*${orderId}* — ${s.label}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      session.step = "idle"; return;
    }
    await sendMessage(phone, "Please share a valid Order ID like *FW-1234*."); return;
  }

  // ── Smart price — item named without price keyword ──
  const itemPrice = smartPriceLookup(t);
  if (itemPrice) {
    await sendMessage(phone, `💰 *${itemPrice}*\n\n⚠️ _Final rate may vary based on cloth quality & work_\n\nType *pickup* to book now! 🧺`);
    return;
  }

  // ── Price keywords ──
  if (has(t, ...PRICE_KW)) {
    if (has(t, ...IRON_KW))      { await sendMessage(phone, RATES.iron); return; }
    if (has(t, ...DC_KW))        { await sendMessage(phone, RATES.dryclean); return; }
    if (has(t, ...WASH_KW))      { await sendMessage(phone, RATES.laundry); return; }
    if (has(t, ...SHOE_KW))      { await sendMessage(phone, RATES.shoes); return; }
    if (has(t, ...HOUSEHOLD_KW)) { await sendMessage(phone, RATES.dryclean); return; }
    await askPriceCategory(phone); return;
  }

  // ── Booking trigger ──
  if (has(t, ...BOOKING_KW)) {
    const saved = await getCustomer(phone);
    if (saved) {
      session.step = "confirm_details"; session.booking = {};
      await sendButtons(phone,
        `Welcome back, ${saved.name}! 👋\n\nUse your saved details?\n📍 ${saved.address}`,
        [{ id: "use_saved", title: "✅ Yes, use these" }, { id: "update_details", title: "✏️ Update details" }]
      );
    } else {
      session.step = "get_address"; session.booking = {};
      await sendMessage(phone, "👋 Welcome to *Washkart Laundry*! 🧺\n\nLet's book your pickup.\n\nPlease send me your *pickup address*:");
    }
    return;
  }

  // ── Greeting ──
  if (has(t, ...GREET_KW) && session.step === "idle") {
    const saved = await getCustomer(phone);
    const name = saved ? saved.name : "there";
    session.step = "menu";
    await sendButtons(phone,
      `Hey ${name}! 👋 Welcome to *Washkart Laundry*! 🧺\n\nHow can I help you?`,
      [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
    );
    return;
  }

  // ── Menu buttons ──
  if (text === "btn_book")  { session.step = "idle"; await handleMessage(phone, "pickup"); return; }
  if (text === "btn_price") { await askPriceCategory(phone); return; }
  if (text === "btn_track") {
    const active = await getActiveOrder(phone);
    if (active) {
      const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
      await sendMessage(phone, `📦 *Your Active Order*\n\n🆔 ${active.order_id}\n${s.label}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
    } else {
      session.step = "tracking";
      await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):");
    }
    return;
  }

  // ── Booking flow ──
  if (session.step === "confirm_details") {
    if (text === "use_saved") {
      const saved = await getCustomer(phone);
      session.booking.name = saved.name; session.booking.address = saved.address;
      session.step = "select_date"; await askDate(phone);
    } else if (text === "update_details") {
      session.booking = {}; session.step = "get_address";
      await sendMessage(phone, "📍 Please send me your new *pickup address*:");
    } else {
      await sendButtons(phone, "Please choose one of the options 👇",
        [{ id: "use_saved", title: "✅ Yes, use these" }, { id: "update_details", title: "✏️ Update details" }]);
    }
    return;
  }

  if (session.step === "get_address") {
    if (t.length < 5) { await sendMessage(phone, "Please enter your complete pickup address 📍 (building, area, city)"); return; }
    session.booking.address = rawText; session.step = "get_name";
    await sendMessage(phone, "👤 What's your *name*?"); return;
  }

  if (session.step === "get_name") {
    if (t.length < 2) { await sendMessage(phone, "Please enter your name 👤"); return; }
    session.booking.name = rawText;
    await saveCustomer(phone, rawText, session.booking.address);
    session.step = "select_date"; await askDate(phone); return;
  }

  if (session.step === "select_date") {
    if (text === "date_today")         { session.booking.date = getToday(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_tomorrow") { session.booking.date = getTomorrow(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_custom")   { session.step = "get_custom_date"; await sendMessage(phone, "📅 Please type your preferred date (e.g. *26 April*):"); }
    else { await sendButtons(phone, "Please select a date 📅", [{ id: "date_today", title: "Today" }, { id: "date_tomorrow", title: "Tomorrow" }, { id: "date_custom", title: "📆 Choose date" }]); }
    return;
  }

  if (session.step === "get_custom_date") { session.booking.date = rawText; session.step = "select_slot"; await askSlot(phone); return; }

  if (session.step === "select_slot") {
    if (text === "slot_morning")       { session.booking.slot = "Morning (10 AM – 1 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
    else if (text === "slot_evening")  { session.booking.slot = "Evening (5 PM – 8 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
    else { await sendButtons(phone, "Please select a time slot 🕐", [{ id: "slot_morning", title: "🌅 10 AM – 1 PM" }, { id: "slot_evening", title: "🌆 5 PM – 8 PM" }]); }
    return;
  }

  // ── Fallback ──
  await sendButtons(phone,
    "Hi! 👋 How can I help you?\n\nType *pickup* to book, *rates* for pricing, or *track* to check your order.",
    [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
  );
  session.step = "menu";
}

// ── REMINDER SYSTEM ──────────────────────────────────────────────
async function sendReminders() {
  try {
    const today = getToday();
    const rows = await dbSelect("bookings", `date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const hour = new Date().getHours();
    for (const b of rows) {
      const isMorning = b.slot.includes("Morning");
      const isEvening = b.slot.includes("Evening");
      if ((isMorning && hour === 8) || (isEvening && hour === 15)) {
        await sendMessage(b.phone,
          `⏰ *Pickup Reminder!*\n\n` +
          `Hi ${b.name}! Your Washkart pickup is *today*.\n\n` +
          `🕐 ${b.slot}\n📍 ${b.address}\n🆔 ${b.order_id}\n\n` +
          `Our team will reach you within the slot. 💚\n` +
          `To cancel: type *cancel ${b.order_id}*`
        );
        await dbUpdate("bookings", `order_id=eq.${b.order_id}`, { reminder_sent: true });
      }
    }
  } catch(e) { console.error("Reminder error:", e.message); }
}
setInterval(sendReminders, 30 * 60 * 1000);

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
    if (processedMessages.has(msg.id)) return res.sendStatus(200);
    processedMessages.add(msg.id);
    setTimeout(() => processedMessages.delete(msg.id), 60000);
    const phone = msg.from;
    if (msg.type === "audio") {
      await sendMessage(phone, "Sorry, I can't process voice notes. Please type your message 😊");
      return res.sendStatus(200);
    }
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

// Status update from dashboard — also notifies customer
app.patch("/bookings/:orderId", async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = req.params.orderId;
    await dbUpdate("bookings", `order_id=eq.${orderId}`, { status });
    // Notify customer
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    if (rows.length > 0 && STATUS_UPDATES[status]) {
      const b = rows[0];
      await sendMessage(b.phone,
        `${STATUS_UPDATES[status]}\n\n🆔 Order: *${orderId}*\n📅 ${b.date} | 🕐 ${b.slot}`
      );
      // After delivery — set feedback step
      if (status === "delivered") {
        if (sessions[b.phone]) sessions[b.phone].step = "feedback";
      }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/customers", async (req, res) => {
  try { res.json(await dbSelect("customers", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart bot running on port ${PORT}`));
