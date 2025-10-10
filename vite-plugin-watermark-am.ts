import { Plugin } from "vite";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export default function watermarkAMPlugin(): Plugin {
  return {
    name: "vite-plugin-watermark-am",

    async buildStart() {
      const configPath = path.resolve(process.cwd(), "watermark.config.js");

      let config = {
        filePath: "index.html",
        before: "",
        after: "",
        text: "",
        command: "",
        targetTag: "footer",
        seperator: " - ",
      };
      if (!fs.existsSync(configPath)) {
        this.warn("watermark.config.js not found");
      } else {
        const imported = await import(configPath);
        config = { ...config, ...(imported.default ?? imported) };
      }

      const filePath = path.resolve(process.cwd(), config.filePath);

      try {
        let html = fs.readFileSync(filePath, "utf-8");

        let text: string[] = [];

        if (config.before) {
          text.push(config.before);
        }

        if (config.text) {
          text.push(config.text.trim());
        }

        if (config.command) {
          text.push(execSync(config.command).toString().trim());
        }

        if (config.after) {
          text.push(config.after);
        }

        if (text.length === 0) {
          return;
        }

        const tag = config.targetTag || "footer";
        const regex = new RegExp(`(<${tag}[^>]*>)[\\s\\S]*?(</${tag}>)`, "gi");

        html = html.replace(regex, `$1${text.join(config.seperator)}$2`);

        fs.writeFileSync(filePath, html, "utf-8");
      } catch (err) {
        console.error("Error updating footer:", err);
      }
    },
  };
}
