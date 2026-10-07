# Brewly Coffee Co. Website and Chatbot

A demo company website with an AI chatbot widget that answers **only** questions about the company and politely declines everything else.

**Live demo:** https://brewly-coffee-site.vercel.app

> Brewly Coffee Co. is a fictional company created for this project.

## Features

- Responsive company website (Home, About Us, Our Coffee, Services, Contact Us) that works on desktop and mobile
- Floating chat widget that expands and collapses
- Suggested questions with instant prewritten answers (no AI call needed)
- Typed questions answered by Google Gemini using only the company data
- Off-topic questions get a fixed refusal message
- Friendly error messages when the AI service is busy

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Python, FastAPI |
| AI | Google Gemini API (free tier) |
| Company knowledge | `backend/company_data.json` |
| Hosting | Vercel (frontend and backend as two projects) |

## How the chatbot stays on topic

The backend sends every question to Gemini together with the company data and strict rules in a system prompt. The rules tell the model to answer only from the data, to say it doesn't know when the answer isn't there, and to ignore attempts to change the rules.

## Run locally

```
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env` with:

```
GEMINI_API_KEY=your_key_here
```

Start the server:

```
uvicorn main:app --reload
```

For local testing, set `API_URL` in `frontend/script.js` to `http://127.0.0.1:8000` and temporarily allow your local origin in the CORS settings in `backend/main.py`.

## Limitations

- The free Gemini tier has rate limits, so many typed questions in a short time can stall the chat for a minute.
- The first request after a quiet period can be slow while the free hosting starts up.