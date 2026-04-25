const express = require("express");
const axios = require("axios");
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

// ── SESSIONS ─────────────────────────────────────────────────────
const sessions = {};
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

// ── KEYWORD GROUPS ───────────────────────────────────────────────
const BOOKING_KW  = ["pickup","book","schedule","start","kapde","dhulai","collect","dhobi","booking","pickup karna","mera kapda","laundry book","wash book","pickup chahiye","pickup karo","pickup karna hai","schedule karo"];
const GREET_KW    = ["hi","hello","hey","hii","helo","namaste","kem cho","namaskar","good morning","good evening","good afternoon","wassup","sup","hola"];
const PRICE_KW    = ["price","rate","rates","cost","charge","kitna","kitne","paisa","how much","rate list","pricing","charges","tariff","batao","bolo","kya hai","what is","what are","fee","fees"];
const TRACK_KW    = ["track","status","order","where","mera order","kahan","kab","delivery","when","kab aayega","kab milega","order status","check order"];
const CANCEL_KW   = ["cancel","cancellation","band karo","nahi chahiye","cancel karo","booking cancel","order cancel"];
const IRON_KW     = ["iron","ironing","press","pressing","istri","istr","kapde press","steam","steam press"];
const DC_KW       = ["dry clean","dryclean","dry-clean","drycleaning","dry cleaning","dc","dryclean","chemical clean"];
const WASH_KW     = ["wash","laundry","washing","dhona","dhulai","fold","wash fold","wash iron","machine wash","laundry wash"];
const SHOE_KW     = ["shoe","shoes","sneaker","sneakers","boot","boots","chappal","sandal","footwear","juta","joote","sports shoe","leather shoe"];
const HOUSEHOLD_KW= ["bedsheet","blanket","curtain","sofa","carpet","bed sheet","sofa cover","ghar","household","home","chadar","razai","parda"];

// ── SMART ITEM PRICE MAP ─────────────────────────────────────────
// Each entry: [keywords[], reply]
const ITEM_MAP = [
  // Iron
  [["normal iron","sada iron","simple iron","normal press"], "Normal Iron — ₹10/pc"],
  [["urgent iron","express iron","jaldi iron","fast iron"], "Urgent Iron — ₹20/pc"],
  [["steam iron","bhap","steam press"], "Steam Iron — ₹20/pc"],
  [["kurta iron","kurta press"], "Kurta Iron — ₹20/pc"],
  [["shawl iron","shawl press","dupatta iron"], "Shawl Iron — ₹40/pc"],
  [["saree iron","saree press","sari iron","sari press"], "Saree Iron — ₹60/pc"],
  [["anarkali iron","anarkali press"], "Anarkali Iron — ₹20/pc"],
  [["lehenga iron","lehnga iron","lehenga press"], "Lehenga Iron — ₹100/pc"],
  [["blazer iron","blazer press","coat iron"], "Blazer Iron — ₹100/pc"],
  [["bedsheet iron","bed sheet iron","chadar iron"], "Bedsheet Iron — ₹40/pc"],
  [["roll press","roll iron"], "Roll Press — ₹120/pc"],
  // Dry clean men
  [["shirt dry","shirt clean","shirt dc"], "Shirt Dry Clean — ₹70"],
  [["trouser dry","pant dry","trouser clean","pant clean"], "Trouser/Pant Dry Clean — ₹70"],
  [["jeans dry","jeans clean","jeans dc"], "Jeans Dry Clean — ₹70"],
  [["tshirt dry","t shirt dry","t-shirt dry","tshirt clean"], "T-Shirt Dry Clean — ₹70"],
  [["kurta dry","kurta clean","kurta dc"], "Kurta Dry Clean — ₹150"],
  [["suit 2","suit two","2 piece suit","2pc suit"], "Suit 2pc Dry Clean — ₹250"],
  [["suit 3","suit three","3 piece suit","3pc suit","3 pc"], "Suit 3pc Dry Clean — ₹350"],
  [["blazer dry","blazer clean","blazer dc","coat dry","coat clean"], "Blazer Dry Clean — ₹250–300"],
  [["jacket dry","jacket clean","jacket dc"], "Jacket Dry Clean — ₹200"],
  [["puffer jacket","puffer dry","winter jacket dry"], "Puffer Jacket Dry Clean — ₹250"],
  [["leather jacket","leather coat"], "Leather Jacket Dry Clean — ₹350"],
  [["sweater dry","sweater clean","woolen dry","woolen clean","sweatshirt dry"], "Sweater Dry Clean — ₹200"],
  [["jodhpuri dry","jodhpuri clean","sherwani dry"], "Jodhpuri Dry Clean — ₹300"],
  [["nawabi","nawab suit"], "Nawabi Suit Dry Clean — ₹350"],
  // Dry clean women
  [["saree dry","saree clean","saree dc","sari dry","sari clean","sari dc"], "Saree Dry Clean — ₹300"],
  [["saree work","work saree","embroidery saree","designer saree dry","designer sari"], "Saree Work Dry Clean — ₹400"],
  [["saree silk","silk saree","silk sari","pure silk"], "Saree Silk Dry Clean — ₹350"],
  [["blouse dry","blouse clean","blouse dc"], "Blouse Dry Clean — ₹70"],
  [["anarkali dry","anarkali clean","anarkali dc"], "Anarkali Dry Clean — ₹200"],
  [["lehenga dry","lehenga clean","lehnga dry","lehnga clean"], "Lehenga Dry Clean — ₹350"],
  [["lehenga heavy","heavy lehenga","bridal lehenga","wedding lehenga"], "Lehenga Heavy Dry Clean — ₹450"],
  [["dress dry","dress clean","frock dry","frock clean"], "Dress Dry Clean — ₹150–200"],
  [["dress gown","gown dry","gown clean","evening gown"], "Dress Gown Dry Clean — ₹300"],
  [["kurti dry","kurti clean","kurti dc"], "Kurti Dry Clean — ₹90"],
  [["dupatta dry","dupatta clean","chunni dry"], "Dupatta Dry Clean — ₹150"],
  [["skirt dry","skirt clean"], "Skirt Dry Clean — ₹90"],
  [["plazo dry","palazzo dry","plazo clean"], "Plazo Dry Clean — ₹100"],
  [["scarf dry","scarf clean","muffler dry"], "Scarf Dry Clean — ₹100"],
  [["night wear","nightwear","nighty dry","nighty clean"], "Night Wear Dry Clean — ₹150"],
  [["dhoti dry","dhoti clean"], "Dhoti Dry Clean — ₹150"],
  [["legging dry","legging clean"], "Legging Dry Clean — ₹70"],
  // Household
  [["single bedsheet","single bed sheet","single chadar","1 bedsheet"], "Single Bedsheet Wash — ₹120/kg"],
  [["double bedsheet","double bed sheet","double chadar","2 bedsheet"], "Double Bedsheet Wash — ₹120/kg"],
  [["single blanket","ek razai","1 blanket"], "Single Blanket Wash — ₹250/kg"],
  [["double blanket","do razai","2 blanket"], "Double Blanket Wash — ₹250/kg"],
  [["curtain wash","parda wash","curtain clean","parda clean"], "Curtain Wash — ₹300/kg"],
  [["sofa cover","sofa wash","sofa clean"], "Sofa Cover Wash — ₹150/kg"],
  [["carpet wash","carpet clean","carpet dhona","dhari wash"], "Carpet Wash — ₹300/kg"],
  [["table cloth","tablecloth"], "Table Cloth Wash — included in laundry"],
  [["towel wash","towel clean"], "Towel — included in laundry"],
  // Laundry
  [["wash fold","washing fold","fold wash","dhona fold"], "Wash & Fold — ₹59/kg (min 1kg)"],
  [["wash iron","washing iron","iron wash","dhona press"], "Wash & Iron — ₹79/kg (min 1kg)"],
  // Shoes
  [["sneaker","sneakers","canvas shoe","white shoe","converse"], "Sneakers Cleaning — ₹300/pair"],
  [["leather shoe","formal shoe","oxford","bata shoe"], "Leather Shoes Cleaning — ₹400/pair"],
  [["slide","slides","slipper","chappal clean"], "Slides Cleaning — ₹200/pair"],
  [["sports shoe","running shoe","gym shoe","nike","adidas","puma"], "Sports Shoes Cleaning — ₹250/pair"],
];

// ── RATE TEXTS ───────────────────────────────────────────────────
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
    "Shirt / Trouser / Jeans / T-Shirt — ₹70\n" +
    "Kurta — ₹150 | Tie — ₹70\n" +
    "Blazer — ₹250–300 | Nawabi — ₹350\n" +
    "Suit 2pc — ₹250 | Suit 3pc — ₹350\n" +
    "Sweater — ₹200 | Vest Coat — ₹150\n" +
    "Jacket — ₹200 | Puffer Jacket — ₹250\n" +
    "Leather Jacket — ₹350 | Jodhpuri — ₹300\n\n" +
    "👗 *Women*\n" +
    "Blouse / Top / T-Shirt / Shirt — ₹70\n" +
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
      address: booking.address, date: booking.date, slot: booking.slot, status: "pending",
      reminder_sent: false
    });
  } catch(e) { console.error("saveBooking:", e.message); }
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
    `Our team will reach you before pickup. 💚\n` +
    `💰 Payment via UPI/Cash at pickup.\n\n` +
    `Type *cancel ${orderId}* to cancel anytime.`
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
  const text = rawText; // original for button IDs

  // ── Price category button replies ──
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

  // ── Cancellation (works anytime, any step) ──
  if (has(t, ...CANCEL_KW)) {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0 && rows[0].phone === phone) {
          if (rows[0].status === "delivered") {
            await sendMessage(phone, `❌ Order *${orderId}* is already delivered and cannot be cancelled.`);
          } else {
            await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
            await sendMessage(phone, `✅ Order *${orderId}* has been cancelled successfully.\n\nNeed to book again? Type *pickup* anytime! 🧺`);
            await sendMessage(ADMIN_NUMBER, `❌ *Booking Cancelled*\n\n🆔 ${orderId}\n👤 ${rows[0].name}\n📅 ${rows[0].date}\n🕐 ${rows[0].slot}`);
          }
        } else {
          await sendMessage(phone, `❌ Order *${orderId}* not found or doesn't belong to this number.`);
        }
      } catch { await sendMessage(phone, "Sorry, couldn't process cancellation. Please try again."); }
      session.step = "idle";
      return;
    } else {
      await sendMessage(phone, "To cancel, please type: *cancel FW-XXXX* (your Order ID)\n\nDon't know your Order ID? Type *track* to find it.");
      return;
    }
  }

  // ── Tracking (works anytime) ──
  if (has(t, ...TRACK_KW) && session.step !== "tracking") {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const statusMap = { pending: "⏳ Pending pickup", picked: "🚗 Picked up — being washed", washing: "🫧 Washing in progress", delivered: "✅ Delivered!", cancelled: "❌ Cancelled" };
          await sendMessage(phone, `*${orderId}* — ${statusMap[rows[0].status] || rows[0].status}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      return;
    }
    session.step = "tracking";
    await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):"); return;
  }
  if (session.step === "tracking") {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const statusMap = { pending: "⏳ Pending pickup", picked: "🚗 Picked up — being washed", washing: "🫧 Washing in progress", delivered: "✅ Delivered!", cancelled: "❌ Cancelled" };
          await sendMessage(phone, `*${orderId}* — ${statusMap[rows[0].status] || rows[0].status}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      session.step = "idle"; return;
    }
    await sendMessage(phone, "Please share a valid Order ID like *FW-1234*."); return;
  }

  // ── Smart price lookup (works anytime) ──
  const isPriceQuery = has(t, ...PRICE_KW);
  if (isPriceQuery) {
    const item = smartPriceLookup(t);
    if (item) {
      await sendMessage(phone, `💰 *${item}*\n\n⚠️ _Final rate may vary based on cloth quality & work_\n\nType *pickup* to book now! 🧺`);
      return;
    }
    if (has(t, ...IRON_KW))      { await sendMessage(phone, RATES.iron); return; }
    if (has(t, ...DC_KW))        { await sendMessage(phone, RATES.dryclean); return; }
    if (has(t, ...WASH_KW))      { await sendMessage(phone, RATES.laundry); return; }
    if (has(t, ...SHOE_KW))      { await sendMessage(phone, RATES.shoes); return; }
    if (has(t, ...HOUSEHOLD_KW)) { await sendMessage(phone, RATES.dryclean); return; }
    session.step = "price_category";
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

  // ── Menu button replies ──
  if (text === "btn_book")  { session.step = "idle"; await handleMessage(phone, "pickup"); return; }
  if (text === "btn_price") { await askPriceCategory(phone); return; }
  if (text === "btn_track") { session.step = "tracking"; await sendMessage(phone, "🔍 Please share your *Order ID* (e.g. FW-1234):"); return; }

  // ── Booking flow steps ──
  if (session.step === "confirm_details") {
    if (text === "use_saved") {
      const saved = await getCustomer(phone);
      session.booking.name = saved.name; session.booking.address = saved.address;
      session.step = "select_date"; await askDate(phone);
    } else if (text === "update_details") {
      session.booking = {}; session.step = "get_address";
      await sendMessage(phone, "📍 Please send me your new *pickup address*:");
    } else {
      // Mid-flow confusion
      await sendButtons(phone, "Please choose one of the options below 👇",
        [{ id: "use_saved", title: "✅ Yes, use these" }, { id: "update_details", title: "✏️ Update details" }]);
    }
    return;
  }

  if (session.step === "get_address") {
    if (t.length < 5) {
      await sendMessage(phone, "Please enter your complete pickup address 📍 (building, area, city)"); return;
    }
    session.booking.address = rawText; session.step = "get_name";
    await sendMessage(phone, "👤 What's your *name*?"); return;
  }

  if (session.step === "get_name") {
    if (t.length < 2) {
      await sendMessage(phone, "Please enter your name 👤"); return;
    }
    session.booking.name = rawText;
    await saveCustomer(phone, rawText, session.booking.address);
    session.step = "select_date"; await askDate(phone); return;
  }

  if (session.step === "select_date") {
    if (text === "date_today")    { session.booking.date = getToday(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_tomorrow") { session.booking.date = getTomorrow(); session.step = "select_slot"; await askSlot(phone); }
    else if (text === "date_custom")   { session.step = "get_custom_date"; await sendMessage(phone, "📅 Please type your preferred date (e.g. *26 April*):"); }
    else {
      // Mid-flow confusion
      await sendButtons(phone, "Please select a date for pickup 📅",
        [{ id: "date_today", title: "Today" }, { id: "date_tomorrow", title: "Tomorrow" }, { id: "date_custom", title: "📆 Choose date" }]);
    }
    return;
  }

  if (session.step === "get_custom_date") {
    session.booking.date = rawText; session.step = "select_slot"; await askSlot(phone); return;
  }

  if (session.step === "select_slot") {
    if (text === "slot_morning")      { session.booking.slot = "Morning (10 AM – 1 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
    else if (text === "slot_evening") { session.booking.slot = "Evening (5 PM – 8 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
    else {
      // Mid-flow confusion
      await sendButtons(phone, "Please select your preferred time slot 🕐",
        [{ id: "slot_morning", title: "🌅 10 AM – 1 PM" }, { id: "slot_evening", title: "🌆 5 PM – 8 PM" }]);
    }
    return;
  }

  // ── Fallback ──
  await sendButtons(phone, "Hi! 👋 How can I help you?\n\nType *pickup* to book, *rates* for pricing, or *track* to check your order.",
    [{ id: "btn_book", title: "📦 Book Pickup" }, { id: "btn_price", title: "💰 Rates" }, { id: "btn_track", title: "🔍 Track Order" }]
  );
  session.step = "menu";
}

// ── REMINDER SYSTEM ──────────────────────────────────────────────
async function sendReminders() {
  try {
    const today = getToday();
    const rows = await dbSelect("bookings", `date=eq.${today}&status=eq.pending&reminder_sent=eq.false`);
    const now = new Date();
    const hour = now.getHours();

    for (const b of rows) {
      const isMorning = b.slot.includes("Morning");
      const isEvening = b.slot.includes("Evening");
      // Morning slot: remind at 8am (hour === 8)
      // Evening slot: remind at 3pm (hour === 15)
      if ((isMorning && hour === 8) || (isEvening && hour === 15)) {
        await sendMessage(b.phone,
          `⏰ *Pickup Reminder!*\n\n` +
          `Hi ${b.name}! Your Washkart pickup is scheduled *today*.\n\n` +
          `🕐 Slot: ${b.slot}\n` +
          `📍 Address: ${b.address}\n` +
          `🆔 Order: ${b.order_id}\n\n` +
          `Our team will reach you within the slot. 💚\n` +
          `To cancel: type *cancel ${b.order_id}*`
        );
        await dbUpdate("bookings", `order_id=eq.${b.order_id}`, { reminder_sent: true });
      }
    }
  } catch(e) { console.error("Reminder error:", e.message); }
}

// Run reminder check every 30 minutes
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
    const phone = msg.from;
    // Ignore voice notes gracefully
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
app.patch("/bookings/:orderId", async (req, res) => {
  try { await dbUpdate("bookings", `order_id=eq.${req.params.orderId}`, { status: req.body.status }); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/customers", async (req, res) => {
  try { res.json(await dbSelect("customers", "order=created_at.desc")); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
const path = require("path");

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/", (req, res) => res.send("Washkart Bot is running! 🧺"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Washkart bot running on port ${PORT}`));
