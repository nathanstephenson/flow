import { connect } from "../../../src/client/connection.ts";

/**
 * The app's link to the Session Host.
 *
 * `url: ""` makes every request same-origin, which is the whole arrangement: in a binary the Session
 * Host serves this app itself, and in development Vite proxies `/api` and `/auth` to it, so there is
 * one origin either way and no CORS anywhere (ADR 0004). No token is passed because there is none to
 * pass — it is the HttpOnly cookie the `/auth` handoff set, which is why that handoff exists.
 *
 * One Connection for the whole app rather than one per Agent Session: `connect` holds no state of its
 * own, and each `subscribe` call is an independent stream, so sharing it costs nothing and keeps the
 * URL and the credentials decision in one place.
 */
export const host = connect({ url: "" });
