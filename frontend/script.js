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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(API_URL + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const data = await response.json();

    if (response.ok) {
      reply.textContent = data.reply;
    } else if (typeof data.detail === "string") {
      reply.textContent = data.detail;
    } else {
      reply.textContent = "Something went wrong. Please try again.";
    }
  } catch (error) {
    if (error.name === "AbortError") {
      reply.textContent = "That took too long. Please try again in a minute.";
    } else {
      reply.textContent = "Can't reach the assistant. Please try again in a moment.";
    }
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