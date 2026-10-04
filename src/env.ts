// Load ./.env (cwd) into process.env before anything reads it. Node's built-in
// loader; variables already set in the shell win over the file. No .env is fine.
import fs from "node:fs";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
