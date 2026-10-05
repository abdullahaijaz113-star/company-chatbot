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

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

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

sendBtn.addEventListener("click", sendMessage);
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