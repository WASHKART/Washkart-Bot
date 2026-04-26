const express = require("express");
const axios = require("axios");
const path = require("path");
const app = express();
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────────
const TOKEN = "EAAST7Y5o9b0BRQmXq21AepqpGRuAfr4iPWQZB1TZC3an1X88vTye9aS2pKkm2pAN6b0wRsxfHbVTrFZBcbDMH0aZAPXivhtBXc5OwmgmAUSipjwBuZABLEyuHFZARZAWuC3iVL2kocytNvZCUZC85z9LXUAwK3E608ZCuOmNUv7E1GND7k1KsG49Ujwzw3T7QrlkgVWgZDZD";
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

const sessions = {};
const processedMessages = new Set();
function getSession(p) {
  if (!sessions[p]) sessions[p] = { step: "idle", booking: {} };
  return sessions[p];
}

// ── DATE UTILS ───────────────────────────────────────────────────
function formatDate(d) { return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }); }
function getToday() { return formatDate(new Date()); }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate()+1); return formatDate(d); }
function isThursday(dateStr) {
  // Check if a date string contains Thursday
  if (dateStr && dateStr.toLowerCase().includes("thursday")) return true;
  return false;
}
function isTodayThursday() { return new Date().getDay() === 4; }
function isTomorrowThursday() { const d = new Date(); d.setDate(d.getDate()+1); return d.getDay() === 4; }

function calcDeliveryDate(service, express, fromDate) {
  // Hours needed per service
  const hours = {
    iron: express ? 4 : 36,
    laundry: express ? 4 : 72,
    dryclean: express ? 4 : 96,
    shoes: express ? 4 : 48,
    mixed: express ? 4 : 96,
  };
  const h = hours[service] || 72;
  const base = fromDate ? new Date(fromDate) : new Date();
  base.setHours(base.getHours() + h);
  // Skip Thursday
  if (base.getDay() === 4) base.setDate(base.getDate() + 1);
  return formatDate(base);
}

function genOrderId() { return "FW-" + Math.floor(1000 + Math.random() * 9000); }
function has(t, ...words) { return words.some(w => t.includes(w)); }
function normalize(t) { return t.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " "); }

// ── STATUS CONFIG ────────────────────────────────────────────────
const STATUS_MAP = {
  pending:        { label: "⏳ Pending pickup",     eta: "Our team will pick up within your selected slot." },
  picked:         { label: "🚗 Picked up",           eta: "Clothes picked up! Cleaning starts soon." },
  inprogress:     { label: "🫧 In Progress",         eta: "Your clothes are being cleaned carefully." },
  outfordelivery: { label: "🚚 Out for Delivery",    eta: "Your clothes are on the way!" },
  delivered:      { label: "✅ Delivered",           eta: "Thank you for choosing Washkart! 🙏" },
  cancelled:      { label: "❌ Cancelled",           eta: "This order was cancelled." },
};

// ── KEYWORDS ─────────────────────────────────────────────────────
const BOOKING_KW   = ["pickup","book","schedule","start","kapde","dhulai","collect","dhobi","booking","pickup karna","mera kapda","laundry book","wash book","pickup chahiye","pickup karo","pickup karna hai","schedule karo","book karna","book karo","order karna","seva"];
const GREET_KW     = ["hi","hello","hey","hii","helo","namaste","kem cho","namaskar","good morning","good evening","good afternoon","wassup","sup","hola","jai shree","radhe radhe","sat sri akal"];
const PRICE_KW     = ["price","rate","rates","cost","charge","how much","rate list","pricing","charges","tariff","fee","fees","price list","rate card","how much for","what's the cost","tell me the price","give me rates","show rates","how much does","what do you charge","charges for","cost of","price of","price for","how much is","what is the rate","what are the rates","kitna","kitne","paisa","kitna lagega","kitne mein","kitna paisa","kitne ka","kitna hoga","bata do","bolo bhai","kya rate hai","rate kya hai","price kya hai","kya charge hai","charge kya hai","kya lagega","lagega kitna","batao","bolo","kiti","kiti rupaye","kiti paisa","kiti lagel","sangaa","dar"];
const TRACK_KW     = ["track","status","order","where","mera order","kahan","kab","delivery","when","kab aayega","kab milega","order status","check order","my order","kitna time","kitna time lagega","kab tak","time lagega","kitna waqt","delivery time","kab deliver","how long","how much time","eta","where is my","when will","order track","mera kapda kahan","kiti vel","keva milel"];
const CANCEL_KW    = ["cancel","cancellation","band karo","nahi chahiye","cancel karo","booking cancel","order cancel","raddh karo","cancel karna"];
const EXPRESS_KW   = ["express","urgent","jaldi","fast","4 hour","4hr","same day","asap","jaldi chahiye","urgent hai"];
const IRON_KW      = ["iron","ironing","press","pressing","istri","istr","kapde press","steam","steam press"];
const DC_KW        = ["dry clean","dryclean","dry-clean","drycleaning","dry cleaning","dc","chemical clean","chemical wash"];
const WASH_KW      = ["wash","laundry","washing","dhona","dhulai","fold","wash fold","wash iron","machine wash","laundry wash"];
const SHOE_KW      = ["shoe","shoes","sneaker","sneakers","boot","boots","chappal","sandal","footwear","juta","joote","sports shoe","leather shoe"];
const HOUSEHOLD_KW = ["bedsheet","blanket","curtain","sofa","carpet","bed sheet","sofa cover","chadar","razai","parda","rajai"];

// ── ITEM PRICE MAP ───────────────────────────────────────────────
const ITEM_MAP = [
  [["normal iron","sada iron","simple iron","normal press","plain iron"], "Normal Iron", 10],
  [["urgent iron","express iron","jaldi iron","fast iron"], "Urgent Iron", 20],
  [["steam iron","bhap","steam press"], "Steam Iron", 20],
  [["kurta iron","kurta press","kurti iron","kurti press"], "Kurta/Kurti Iron", 20],
  [["shawl iron","shawl press","dupatta iron","dupatta press"], "Shawl/Dupatta Iron", 40],
  [["saree iron","saree press","sari iron","sari press"], "Saree Iron", 60],
  [["anarkali iron","anarkali press"], "Anarkali Iron", 20],
  [["lehenga iron","lehnga iron","lehenga press"], "Lehenga Iron", 100],
  [["blazer iron","blazer press","coat iron","jacket iron"], "Blazer/Coat Iron", 100],
  [["bedsheet iron","bed sheet iron","chadar iron"], "Bedsheet Iron", 40],
  [["roll press","roll iron"], "Roll Press", 120],
  [["shirt iron","shirt press"], "Shirt Iron", 20],
  [["pant iron","trouser iron","pant press"], "Pant/Trouser Iron", 20],
  [["shirt dry","shirt clean","shirt dc"], "Shirt Dry Clean", 70],
  [["trouser dry","pant dry","trouser clean","pant clean"], "Trouser/Pant Dry Clean", 70],
  [["jeans dry","jeans clean","jeans dc"], "Jeans Dry Clean", 70],
  [["tshirt dry","t shirt dry","t-shirt dry","tshirt clean"], "T-Shirt Dry Clean", 70],
  [["kurta dry","kurta clean","kurta dc"], "Kurta Dry Clean", 150],
  [["suit 2","suit two","2 piece","2pc suit"], "Suit 2pc Dry Clean", 250],
  [["suit 3","suit three","3 piece","3pc suit"], "Suit 3pc Dry Clean", 350],
  [["blazer dry","blazer clean","blazer dc","coat dry"], "Blazer Dry Clean", 275],
  [["jacket dry","jacket clean","jacket dc"], "Jacket Dry Clean", 200],
  [["puffer jacket","puffer dry","winter jacket"], "Puffer Jacket Dry Clean", 250],
  [["leather jacket","leather coat"], "Leather Jacket Dry Clean", 350],
  [["sweater dry","sweater clean","woolen dry","sweatshirt dry"], "Sweater Dry Clean", 200],
  [["jodhpuri dry","jodhpuri clean","sherwani dry"], "Jodhpuri/Sherwani Dry Clean", 300],
  [["nawabi","nawab suit"], "Nawabi Suit Dry Clean", 350],
  [["saree dry","saree clean","saree dc","sari dry","sari clean"], "Saree Dry Clean", 300],
  [["saree work","work saree","embroidery saree","designer saree","heavy saree"], "Saree Work Dry Clean", 400],
  [["saree silk","silk saree","silk sari","pure silk"], "Saree Silk Dry Clean", 350],
  [["blouse dry","blouse clean","blouse dc"], "Blouse Dry Clean", 70],
  [["anarkali dry","anarkali clean","anarkali dc"], "Anarkali Dry Clean", 200],
  [["lehenga dry","lehenga clean","lehnga dry","lehnga clean"], "Lehenga Dry Clean", 350],
  [["lehenga heavy","heavy lehenga","bridal lehenga","wedding lehenga"], "Lehenga Heavy Dry Clean", 450],
  [["dress dry","dress clean","frock dry","frock clean"], "Dress Dry Clean", 175],
  [["dress gown","gown dry","gown clean","evening gown"], "Dress Gown Dry Clean", 300],
  [["kurti dry","kurti clean","kurti dc"], "Kurti Dry Clean", 90],
  [["dupatta dry","dupatta clean","chunni dry"], "Dupatta Dry Clean", 150],
  [["skirt dry","skirt clean","skirt dc"], "Skirt Dry Clean", 90],
  [["plazo dry","palazzo dry","plazo clean"], "Plazo Dry Clean", 100],
  [["scarf dry","scarf clean","muffler dry","stole dry"], "Scarf/Stole Dry Clean", 100],
  [["night wear","nightwear","nighty dry","nighty clean"], "Night Wear Dry Clean", 150],
  [["dhoti dry","dhoti clean"], "Dhoti Dry Clean", 150],
  [["legging dry","legging clean"], "Legging Dry Clean", 70],
  [["blanket wash","razai wash","rajai wash","blanket clean"], "Blanket Wash", 250],
  [["curtain wash","parda wash","curtain clean"], "Curtain Wash", 300],
  [["sofa cover","sofa wash","sofa clean"], "Sofa Cover Wash", 150],
  [["carpet wash","carpet clean","carpet dhona"], "Carpet Wash", 300],
  [["wash fold","washing fold","fold wash","wash and fold"], "Wash & Fold", 59],
  [["wash iron","washing iron","iron wash","wash and iron"], "Wash & Iron", 79],
  [["bedsheet wash","bed sheet wash","chadar wash"], "Bedsheet Wash", 120],
  [["sneaker","sneakers","canvas shoe","white shoe","converse"], "Sneakers Cleaning", 300],
  [["leather shoe","formal shoe","oxford","bata shoe"], "Leather Shoes Cleaning", 400],
  [["slide","slides","slipper clean","chappal clean"], "Slides Cleaning", 200],
  [["sports shoe","running shoe","gym shoe","nike shoe","adidas shoe"], "Sports Shoes Cleaning", 250],
];

// ── MOBILE FRIENDLY RATES ────────────────────────────────────────
const RATES = {
  iron:
    "🔥 *IRONING RATES*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👕 Normal Iron — ₹10\n" +
    "⚡ Urgent Iron — ₹20\n" +
    "💨 Steam Iron — ₹20\n" +
    "👔 Shirt / Pant — ₹20\n" +
    "👘 Kurta / Kurti — ₹20\n" +
    "🧣 Shawl / Dupatta — ₹40\n" +
    "🥻 Saree — ₹60\n" +
    "💃 Anarkali — ₹20\n" +
    "👗 Lehenga — ₹100\n" +
    "🧥 Blazer / Coat — ₹100\n" +
    "🛏 Bedsheet — ₹40\n" +
    "💈 Saree Steam — ₹100\n" +
    "🔄 Roll Press — ₹120\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚠️ Rates may vary by cloth quality",

  dryclean:
    "🧥 *DRY CLEAN RATES*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👔 *MEN*\n" +
    "Shirt — ₹70\n" +
    "Trouser / Pant — ₹70\n" +
    "Jeans — ₹70\n" +
    "T-Shirt — ₹70\n" +
    "Kurta — ₹150\n" +
    "Tie — ₹70\n" +
    "Blazer — ₹250–300\n" +
    "Suit 2pc — ₹250\n" +
    "Suit 3pc — ₹350\n" +
    "Sweater — ₹200\n" +
    "Jacket — ₹200\n" +
    "Puffer Jacket — ₹250\n" +
    "Leather Jacket — ₹350\n" +
    "Jodhpuri — ₹300\n" +
    "Nawabi — ₹350\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👗 *WOMEN*\n" +
    "Blouse / Top / T-Shirt — ₹70\n" +
    "Kurti — ₹90\n" +
    "Skirt — ₹90\n" +
    "Legging — ₹70\n" +
    "Plazo — ₹100\n" +
    "Dupatta — ₹150\n" +
    "Scarf / Stole — ₹100\n" +
    "Saree — ₹300\n" +
    "Saree Work — ₹400\n" +
    "Saree Silk — ₹350\n" +
    "Anarkali — ₹200\n" +
    "Lehenga — ₹350\n" +
    "Lehenga Heavy — ₹450\n" +
    "Dress — ₹150–200\n" +
    "Dress Gown — ₹300\n" +
    "Sweater — ₹150\n" +
    "Night Wear — ₹150\n" +
    "Dhoti — ₹150\n" +
    "━━━━━━━━━━━━━━━\n" +
    "🏠 *HOUSEHOLD*\n" +
    "Curtains — ₹10/pc\n" +
    "Towel Large — ₹100\n" +
    "Table Cloth — ₹80\n" +
    "Shawl — ₹150\n" +
    "Hand Bag — ₹400\n" +
    "Single Blanket — ₹300\n" +
    "Double Blanket — ₹400\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚠️ Rates may vary by cloth quality & work",

  laundry:
    "🫧 *LAUNDRY / WASHING RATES*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👕 Wash & Fold — ₹59/kg\n" +
    "🧺 Wash & Iron — ₹79/kg\n" +
    "🛏 Bedsheet Wash — ₹120/kg\n" +
    "🛌 Blanket Wash — ₹250/kg\n" +
    "🪟 Curtain Wash — ₹300/kg\n" +
    "🛋 Sofa Cover — ₹150/kg\n" +
    "🪣 Carpet — ₹300/kg\n" +
    "━━━━━━━━━━━━━━━\n" +
    "📦 Minimum 1kg\n" +
    "🚚 Free pickup above ₹300\n" +
    "⚠️ Rates may vary by cloth quality",

  shoes:
    "👟 *SHOE CLEANING RATES*\n" +
    "━━━━━━━━━━━━━━━\n" +
    "👟 Sneakers — ₹300/pair\n" +
    "👞 Leather Shoes — ₹400/pair\n" +
    "🩴 Slides — ₹200/pair\n" +
    "🏃 Sports Shoes — ₹250/pair\n" +
    "━━━━━━━━━━━━━━━\n" +
    "⚠️ Rates may vary by condition",
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
  const todayThurs = isTodayThursday();
  const tmrwThurs = isTomorrowThursday();
  const buttons = [];
  if (!todayThurs) buttons.push({ id: "date_today", title: "Today" });
  if (!tmrwThurs) buttons.push({ id: "date_tomorrow", title: "Tomorrow" });
  buttons.push({ id: "date_custom", title: "📆 Choose date" });
  const note = todayThurs
    ? "⚠️ We're closed today (Thursday). Please choose another day.\n\n📅 When would you like pickup?"
    : "📅 Which day works for pickup?";
  await sendButtons(phone, note, buttons);
}

async function askSlot(phone) {
  await sendButtons(phone, "🕐 Pick your time slot:", [
    { id: "slot_morning", title: "🌅 10 AM – 1 PM" },
    { id: "slot_evening", title: "🌆 5 PM – 8 PM" }
  ]);
}

async function askPriceCategory(phone) {
  await sendButtons(phone,
    "💰 Which service rates would you like to see?",
    [{ id: "price_iron", title: "🔥 Ironing" }, { id: "price_dc", title: "🧥 Dry Clean" }, { id: "price_wash", title: "🫧 Laundry/Wash" }]
  );
  setTimeout(async () => {
    await sendButtons(phone, "👇 More options:",
      [{ id: "price_shoe", title: "👟 Shoe Cleaning" }, { id: "btn_book", title: "📦 Book Pickup" }]
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
  for (const [keywords, name, price] of ITEM_MAP) {
    if (keywords.some(k => t.includes(k))) return { name, price };
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

  // ── Express reply ──
  if (has(t, ...EXPRESS_KW) && session.step === "idle") {
    const active = await getActiveOrder(phone);
    if (active && active.status === "picked") {
      // Check if today is Thursday
      if (isTodayThursday()) {
        await sendMessage(phone, "Sorry, express service is not available on Thursdays. 🙏\n\nYour order will be delivered on the standard timeline.");
        return;
      }
      const deliveryDate = calcDeliveryDate(active.service_type || "mixed", true, null);
      await sendMessage(phone,
        `⚡ *Express Confirmed!*\n\n` +
        `Your clothes will be cleaned and delivered within *4 hours* of pickup. Our team is on it! 🙌\n\n` +
        `📅 Delivery by: *Today*\n` +
        `💰 Express charges apply — final bill shared at delivery.\n\n` +
        `🆔 Order: ${active.order_id}`
      );
      await dbUpdate("bookings", `order_id=eq.${active.order_id}`, { express: true });
      await sendMessage(ADMIN_NUMBER, `⚡ *Express Requested!*\n\n🆔 ${active.order_id}\n👤 ${active.name}\n📱 ${active.phone}`);
      return;
    }
    await sendMessage(phone, "Express service can be requested after your clothes are picked up. Type *pickup* to book first! 🧺");
    return;
  }

  // ── Cancellation ──
  if (has(t, ...CANCEL_KW)) {
    const match = rawText.match(/FW-\d{4}/i);
    const active = await getActiveOrder(phone);
    const orderId = match ? match[0].toUpperCase() : active?.order_id;
    if (orderId) {
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          if (["delivered","cancelled"].includes(rows[0].status)) {
            await sendMessage(phone, `❌ Order *${orderId}* cannot be cancelled (${STATUS_MAP[rows[0].status]?.label}).`);
          } else {
            await sendButtons(phone,
              `Cancel order *${orderId}*?\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}`,
              [{ id: `confirm_cancel_${orderId}`, title: "✅ Yes, Cancel" }, { id: "no_cancel", title: "❌ No, Keep it" }]
            );
            session.step = "confirm_cancel";
          }
        }
      } catch { await sendMessage(phone, "Sorry, couldn't process. Try again."); }
    } else {
      await sendMessage(phone, "No active orders found. Type *pickup* to book! 🧺");
    }
    return;
  }

  // ── Cancel confirmation ──
  if (session.step === "confirm_cancel") {
    if (text.startsWith("confirm_cancel_")) {
      const orderId = text.replace("confirm_cancel_", "");
      const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
      await dbUpdate("bookings", `order_id=eq.${orderId}`, { status: "cancelled" });
      await sendMessage(phone, `✅ Order *${orderId}* cancelled. Type *pickup* to book again! 🧺`);
      await sendMessage(ADMIN_NUMBER, `❌ *Booking Cancelled*\n\n🆔 ${orderId}\n👤 ${rows[0]?.name}\n📅 ${rows[0]?.date}`);
    } else if (text === "no_cancel") {
      await sendMessage(phone, "Got it! Your order is still active. 👍");
    }
    session.step = "idle"; return;
  }

  // ── Tracking ──
  if (has(t, ...TRACK_KW)) {
    const match = rawText.match(/FW-\d{4}/i);
    if (match) {
      const orderId = match[0].toUpperCase();
      try {
        const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
        if (rows.length > 0) {
          const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
          const delivery = rows[0].delivery_date ? `\n📦 Delivery: ${rows[0].delivery_date}` : "";
          await sendMessage(phone, `🆔 *${orderId}*\n${s.label}${delivery}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      return;
    }
    const active = await getActiveOrder(phone);
    if (active) {
      const s = STATUS_MAP[active.status] || { label: active.status, eta: "" };
      const delivery = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
      await sendMessage(phone,
        `📦 *Your Active Order*\n\n` +
        `🆔 ${active.order_id}\n` +
        `${s.label}${delivery}\n` +
        `📅 ${active.date} | 🕐 ${active.slot}\n\n` +
        `${s.eta}`
      );
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
          const s = STATUS_MAP[rows[0].status] || { label: rows[0].status, eta: "" };
          await sendMessage(phone, `🆔 *${orderId}*\n${s.label}\n📅 ${rows[0].date} | 🕐 ${rows[0].slot}\n\n${s.eta}`);
        } else {
          await sendMessage(phone, "❌ Order not found. Please check the Order ID.");
        }
      } catch { await sendMessage(phone, "Sorry, couldn't fetch status. Try again."); }
      session.step = "idle"; return;
    }
    await sendMessage(phone, "Please share a valid Order ID like *FW-1234*."); return;
  }

  // ── Smart item price (no keyword needed) ──
  const itemResult = smartPriceLookup(t);
  if (itemResult) {
    await sendMessage(phone,
      `💰 *${itemResult.name}*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `Standard — ₹${itemResult.price}\n` +
      `⚡ Express (4hr) — ₹${Math.ceil(itemResult.price * 1.5)}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `⚠️ Final rate may vary by cloth quality\n\n` +
      `Type *pickup* to book now! 🧺`
    );
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
    session.step = "menu";
    await sendButtons(phone,
      `Hey ${saved ? saved.name : "there"}! 👋 Welcome to *Washkart Laundry*! 🧺\n\nHow can I help you?`,
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
      const delivery = active.delivery_date ? `\n📦 Est. Delivery: ${active.delivery_date}` : "";
      await sendMessage(phone, `📦 *Your Active Order*\n\n🆔 ${active.order_id}\n${s.label}${delivery}\n📅 ${active.date} | 🕐 ${active.slot}\n\n${s.eta}`);
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
    if (t.length < 5) { await sendMessage(phone, "Please enter your complete pickup address 📍"); return; }
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
    if (text === "date_today") {
      if (isTodayThursday()) { await sendMessage(phone, "We're closed on Thursdays 🙏 Please choose another day!"); await askDate(phone); return; }
      session.booking.date = getToday(); session.step = "select_slot"; await askSlot(phone);
    } else if (text === "date_tomorrow") {
      if (isTomorrowThursday()) { await sendMessage(phone, "We're closed on Thursdays 🙏 Please choose another day!"); await askDate(phone); return; }
      session.booking.date = getTomorrow(); session.step = "select_slot"; await askSlot(phone);
    } else if (text === "date_custom") {
      session.step = "get_custom_date";
      await sendMessage(phone, "📅 Please type your preferred date (e.g. *26 April*):\n\n⚠️ Note: We are closed on Thursdays.");
    } else {
      await sendButtons(phone, "Please select a date 📅",
        [{ id: "date_today", title: "Today" }, { id: "date_tomorrow", title: "Tomorrow" }, { id: "date_custom", title: "📆 Choose date" }]);
    }
    return;
  }

  if (session.step === "get_custom_date") {
    if (isThursday(rawText)) {
      await sendMessage(phone, "Sorry, we are closed on Thursdays 🙏\n\nPlease choose another date:");
      return;
    }
    session.booking.date = rawText; session.step = "select_slot"; await askSlot(phone); return;
  }

  if (session.step === "select_slot") {
    if (text === "slot_morning")      { session.booking.slot = "Morning (10 AM – 1 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
    else if (text === "slot_evening") { session.booking.slot = "Evening (5 PM – 8 PM)"; session.step = "idle"; await confirmBooking(phone, session.booking); }
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
      if ((b.slot?.includes("Morning") && hour === 8) || (b.slot?.includes("Evening") && hour === 15)) {
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

app.patch("/bookings/:orderId", async (req, res) => {
  try {
    const { status, service_type, express, delivery_date } = req.body;
    const orderId = req.params.orderId;
    const updateData = { status };
    if (service_type) updateData.service_type = service_type;
    if (express !== undefined) updateData.express = express;
    if (delivery_date) updateData.delivery_date = delivery_date;
    // Auto calculate delivery date if service type set and no manual date
    if (service_type && !delivery_date) {
      updateData.delivery_date = calcDeliveryDate(service_type, express || false, null);
    }
    await dbUpdate("bookings", `order_id=eq.${orderId}`, updateData);
    const rows = await dbSelect("bookings", `order_id=eq.${orderId}`);
    const b = rows[0];
    // Customer notification
    const msgs = {
      picked: `🚗 *Your clothes have been picked up!*\n\n` +
        (b.service_type ? `🧺 Service: ${b.service_type.charAt(0).toUpperCase()+b.service_type.slice(1)}\n` : "") +
        (b.delivery_date ? `📦 Est. Delivery: *${b.delivery_date}*\n` : "") +
        `\n⚡ Need it urgently? We offer express cleaning — your clothes back in just *4 hours!*\nReply *EXPRESS* to upgrade.\n\n🆔 ${orderId}`,
      inprogress: `🫧 *Your clothes are being cleaned!*\n\nSit back and relax — we're taking great care of them. ✨\n\n` +
        (b.delivery_date ? `📦 Est. Delivery: *${b.delivery_date}*\n` : "") + `🆔 ${orderId}`,
      outfordelivery: `🚚 *Your order is out for delivery!*\n\nYour fresh clothes are on the way. Expect them shortly! 😊\n\n🆔 ${orderId}`,
      delivered: `✅ *Your clothes have been delivered!*\n\nThank you for choosing Washkart! 🙏\n\nHow was your experience? Reply with ⭐ to ⭐⭐⭐⭐⭐`,
    };
    if (msgs[status] && b?.phone) {
      await sendMessage(b.phone, msgs[status]);
      if (status === "delivered" && sessions[b.phone]) sessions[b.phone].step = "feedback";
    }
    res.json({ success: true, delivery_date: updateData.delivery_date });
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
