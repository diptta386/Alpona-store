# Alpona Secure Store v1

This package upgrades the original browser-only prototype into a server-backed store.

## Included
- PostgreSQL database for products, customers, orders, order items, expenses and subscribers
- Secure owner login with bcrypt password hashing and server sessions
- Rate limiting and security headers
- Server-side order totals and inventory checks (customers cannot change prices in the browser)
- Customer email collected during checkout
- Automatic order confirmation email
- Automatic email when the owner changes order status
- Marketing opt-in and unsubscribe support
- Automatic new-product email to active subscribers
- Owner dashboard: orders, products, expenses, revenue and estimated profit
- Basic business report with best seller and low-stock products
- Optional OpenAI customer assistant, with the API key kept on the server

## Important
This version requires a Node.js host and PostgreSQL. GitHub Pages alone cannot run the backend.
Do not put `.env` in GitHub. Only upload `.env.example`.

## Setup
1. Install Node.js 20+ and PostgreSQL (or create a managed PostgreSQL database).
2. Copy `.env.example` to `.env`.
3. Fill `DATABASE_URL`, `SESSION_SECRET`, `OWNER_EMAIL`, and `OWNER_PASSWORD`.
4. To send real email, fill the SMTP settings.
5. To enable the AI assistant, add `OPENAI_API_KEY`. Keep it only in `.env` on the server.
6. Run `npm install`.
7. Run `npm start`.
8. Open `http://localhost:3000`.

The first start automatically creates the database tables, owner account, and starter products.

## Deployment
Use a Node.js-compatible hosting service plus PostgreSQL. Set all secrets as hosting environment variables. Set `SITE_URL` to your real HTTPS domain and `NODE_ENV=production`.

## Email behavior
Transactional order emails do not depend on marketing consent. Marketing/new-product emails are sent only to subscribed customers. Every marketing email includes an unsubscribe link.

## AI safety boundary
The customer AI receives only public product information. It is instructed not to expose owner information, costs, profits, secrets or another customer's private order information. Private order lookup should be added later with identity verification before exposing order details.
