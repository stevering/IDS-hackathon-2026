"use client";

// /chat/<uuid> — specific conversation. Renders the same Home component as
// / and /chat; useParams() inside Home reads `id` from this route and the
// URL ↔ state sync drives `activeConversationId`.
export { default } from "../../page";
