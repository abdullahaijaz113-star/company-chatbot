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
    question: "Do you offer gift boxes?",
    answer: "Yes! Our Gift Boxes include three bags of coffee and a Brewly mug, with an optional handwritten message. You can order one from the Services section on this page.",
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
    const response = await fetch(API_URL + "/products?kind=product");
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

// Services (loaded from the database, clicking one adds it to the cart)
const serviceGrid = document.getElementById("service-grid");

function renderServices(services) {
  serviceGrid.textContent = "";

  if (!services.length) {
    const note = document.createElement("p");
    note.className = "grid-note";
    note.textContent = "No services to show right now.";
    serviceGrid.appendChild(note);
    return;
  }

  services.forEach((s) => {
    const card = document.createElement("article");
    card.className = "card service-card";

    const title = document.createElement("h3");
    title.textContent = s.name;
    card.appendChild(title);

    if (s.description) {
      const desc = document.createElement("p");
      desc.textContent = s.description;
      card.appendChild(desc);
    }

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = "$" + Number(s.price).toFixed(2);
    card.appendChild(price);

    const orderBtn = document.createElement("button");
    orderBtn.type = "button";
    orderBtn.className = "add-to-cart";
    orderBtn.textContent = "Order now";
    card.appendChild(orderBtn);

    card.addEventListener("click", () => addToCart(s));
    serviceGrid.appendChild(card);
  });
}

async function loadServices() {
  if (!serviceGrid) return;
  try {
    const response = await fetch(API_URL + "/products?kind=service");
    if (!response.ok) throw new Error("bad response");
    renderServices(await response.json());
  } catch (error) {
    serviceGrid.textContent = "";
    const note = document.createElement("p");
    note.className = "grid-note";
    note.textContent = "Services could not be loaded right now. Please try again later.";
    serviceGrid.appendChild(note);
  }
}

loadServices();

// Contact form
const contactForm = document.getElementById("contact-form");

async function loadContactTopics() {
  const select = document.getElementById("cf-topic");
  try {
    const response = await fetch(API_URL + "/products?kind=service");
    if (!response.ok) return;
    const services = await response.json();
    const other = select.querySelector("option:last-child");
    services.forEach((s) => {
      const option = document.createElement("option");
      option.value = s.name;
      option.textContent = s.name;
      select.insertBefore(option, other);
    });
  } catch (e) {}
}

if (contactForm) {
  loadContactTopics();

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("contact-status");
    const button = contactForm.querySelector("button[type=submit]");
    status.className = "contact-status";
    status.textContent = "Sending...";
    button.disabled = true;

    try {
      const response = await fetch(API_URL + "/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("cf-name").value,
          email: document.getElementById("cf-email").value,
          phone: document.getElementById("cf-phone").value,
          topic: document.getElementById("cf-topic").value,
          message: document.getElementById("cf-message").value,
          website: document.getElementById("cf-website").value,
        }),
      });
      const data = await response.json().catch(() => null);

      if (response.ok) {
        contactForm.reset();
        status.textContent = "Thank you! We've received your message and will get back to you soon.";
      } else {
        const detail = data && data.detail;
        status.className = "contact-status error";
        if (typeof detail === "string") status.textContent = detail;
        else if (Array.isArray(detail) && detail[0] && detail[0].msg) status.textContent = detail[0].msg;
        else status.textContent = "Something went wrong. Please try again.";
      }
    } catch (e) {
      status.className = "contact-status error";
      status.textContent = "Can't reach the server right now. Please try again.";
    }
    button.disabled = false;
  });
}
// Hero slider
(function () {
  const slides = document.querySelectorAll(".hero-slide");
  const dotsBox = document.getElementById("hero-dots");
  if (slides.length < 2 || !dotsBox) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dots = [];
  let current = 0;
  let timer = null;

  function show(index) {
    current = index;
    slides.forEach((slide, i) => slide.classList.toggle("active", i === index));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
  }

  function start() {
    if (reduceMotion) return;
    timer = setInterval(() => show((current + 1) % slides.length), 5000);
  }

  function restart() {
    clearInterval(timer);
    start();
  }

  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.setAttribute("aria-label", "Show slide " + (i + 1));
    dot.addEventListener("click", () => {
      show(i);
      restart();
    });
    dotsBox.appendChild(dot);
    dots.push(dot);
  });

  show(0);
  start();
})();