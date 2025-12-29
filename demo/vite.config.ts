import { defineConfig } from "vite";
import { tokenShaker } from "vite-plugin-token-shaker";
export default defineConfig({
  // @ts-ignore ts may or may not be stupid
  plugins: [tokenShaker({ verbose: true })],
});
