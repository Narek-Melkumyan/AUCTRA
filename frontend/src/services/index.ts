/**
 * Single entry point for data access. Set VITE_API_MODE=api once a backend
 * implementation (e.g. ./api.ts using fetch + socket.io-client) exists.
 */
import { demoServices } from "./demo";
import { apiServices } from "./api";
import type { Services } from "./types";

export const API_MODE = (import.meta.env["VITE_API_MODE"] as string | undefined) ?? "demo";
export const services: Services = API_MODE === "api" ? apiServices : demoServices;
export type * from "./types";
