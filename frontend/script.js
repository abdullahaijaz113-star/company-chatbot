const API_URL = "https://brewly-chatbot-api.vercel.app";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("message-input");
const sendBtn = document.getElementById("send-button");

// Wake the backend up early (free hosting sleeps when idle)
fetch(API_URL + "/health").catch(() => {});

function addMessage(text, who) {
  const div = document.createElement("div");
  div.className = "message " + who;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function sendMessage(presetText) {
  const text = (presetText || inputEl.value).trim();
  if (!text) return;
  clearSuggestions();

  addMessage(text, "user");
  inputEl.value = "";
  inputEl.disabled = true;
  sendBtn.disabled = true;

  const reply = addMessage("Typing...", "bot typing");

  try {
    const response = await fetch(API_URL + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await response.json();

    if (response.ok) {
      reply.textContent = data.reply;
    } else if (typeof data.detail === "string") {
      reply.textContent = data.detail;
    } else {
      reply.textContent = "Something went wrong. Please try again.";
    }
  } catch (error) {
    reply.textContent = "Can't reach the assistant. Please try again in a moment.";
  }

  reply.classList.remove("typing");
  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

sendBtn.addEventListener("click", () => sendMessage());
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendMessage();
});
// Open and close the chat widget
const launcher = document.getElementById("chat-launcher");
const chatWindow = document.getElementById("chat-window");
const closeBtn = document.getElementById("chat-close");

function setChatOpen(open) {
  chatWindow.classList.toggle("open", open);
  launcher.classList.toggle("is-open", open);
  launcher.textContent = open ? "✕" : "💬";
  launcher.setAttribute("aria-expanded", String(open));
  launcher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
}

launcher.addEventListener("click", () => {
  setChatOpen(!chatWindow.classList.contains("open"));
});
closeBtn.addEventListener("click", () => setChatOpen(false));
// Suggested questions with prewritten answers (instant, no API call)
const SUGGESTED = [
  {
    question: "What is your cheapest coffee?",
    answer: "Our cheapest coffee is Golden Hour at $14.49 for a 12 oz bag. It's a medium roast from Colombia with notes of toffee, red apple, and a smooth body.",
  },
  {
    question: "How long does shipping take?",
    answer: "Orders are roasted and shipped within 48 hours. Standard shipping takes 3-5 business days and costs $4.99, or is free on orders over $35. Express takes 1-2 business days for $12.99. We ship within the United States and Canada, and Canada takes 7-10 business days for $14.99.",
  },
  {
    question: "Do you have decaf?",
    answer: "Yes! Our Decaf Dream is a medium roast from Guatemala, made with the chemical-free Swiss Water process. It has notes of cocoa, almond, and mild sweetness, and costs $16.49 for a 12 oz bag.",
  },
  {
    question: "How do subscriptions work?",
    answer: "You can get coffee delivered weekly, every two weeks, or monthly, and you choose your roast and grind. Subscribers save 10% on every order. You can skip, pause, or cancel anytime from your account page, at least 48 hours before the next shipment.",
  },
  {
    question: "What is your return policy?",
    answer: "If you're unhappy with your coffee, contact us within 30 days for a replacement or a full refund, and you don't need to send the coffee back. Equipment like brewers and mugs can be returned unused within 30 days.",
  },
];

let suggestionsEl = null;

function showSuggestions() {
  suggestionsEl = document.createElement("div");
  suggestionsEl.className = "suggestions";

  SUGGESTED.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion";
    btn.textContent = item.question;
    btn.addEventListener("click", () => answerInstantly(item));
    suggestionsEl.appendChild(btn);
  });

  messagesEl.appendChild(suggestionsEl);
}

function clearSuggestions() {
  if (suggestionsEl) {
    suggestionsEl.remove();
    suggestionsEl = null;
  }
}

function answerInstantly(item) {
  clearSuggestions();
  addMessage(item.question, "user");
  const reply = addMessage("Typing...", "bot typing");
  setTimeout(() => {
    reply.textContent = item.answer;
    reply.classList.remove("typing");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 400);
}

showSuggestions();

// Load products from the database into the Our Coffee section
const productGrid = document.getElementById("product-grid");

function renderPublicProducts(products) {
  productGrid.textContent = "";

  if (!products.length) {
    const note = document.createElement("p");
    note.className = "grid-note";
    note.textContent = "No products to show yet. Please check back soon.";
    productGrid.appendChild(note);
    return;
  }

  products.forEach((p) => {
    const card = document.createElement("article");
    card.className = "card";

    if (p.image_url && p.image_url.startsWith("https://")) {
      const img = document.createElement("img");
      img.className = "card-image";
      img.src = p.image_url;
      img.alt = p.name;
      img.loading = "lazy";
      card.appendChild(img);
    }

    const title = document.createElement("h3");
    title.textContent = p.name;
    card.appendChild(title);

    if (p.description) {
      const desc = document.createElement("p");
      desc.textContent = p.description;
      card.appendChild(desc);
    }

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = "$" + Number(p.price).toFixed(2);
    card.appendChild(price);
    
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-to-cart";
    addBtn.textContent = "Add to cart";
    addBtn.addEventListener("click", () => addToCart(p));
    card.appendChild(addBtn);

    productGrid.appendChild(card);
  });
}

async function loadPublicProducts() {
  if (!productGrid) return;
  try {
    const response = await fetch(API_URL + "/products");
    if (!response.ok) throw new Error("bad response");
    renderPublicProducts(await response.json());
  } catch (error) {
    productGrid.textContent = "";
    const note = document.createElement("p");
    note.className = "grid-note";
    note.textContent = "Products could not be loaded right now. Please try again later.";
    productGrid.appendChild(note);
  }
}

loadPublicProducts();