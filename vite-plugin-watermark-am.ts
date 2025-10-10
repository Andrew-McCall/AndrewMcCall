import { Plugin } from "vite";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

export default function watermarkAMPlugin(): Plugin {
  return {
    name: "vite-plugin-watermark-am",

    async transformIndexHtml(html) {
      const configPath = path.resolve(process.cwd(), "watermark.config.js");

      let config = {
        before: "",
        after: "",
        text: "",
        command: "",
        targetTag: "footer",
        separator: " - ",
      };

      if (fs.existsSync(configPath)) {
        const imported = await import(configPath);
        config = { ...config, ...(imported.default ?? imported) };
      }

      const text: string[] = [];
      if (config.before) text.push(config.before);
      if (config.text) text.push(config.text.trim());
      if (config.command) {
        try {
          const out = execSync(config.command).toString().trim();
          if (out) text.push(out);
        } catch (err) {
          console.warn("Command execution failed:", err);
        }
      }
      if (config.after) text.push(config.after);

      if (text.length === 0) return html;

      const tag = config.targetTag || "footer";
      const content = text.join(config.separator);

      const regex = new RegExp(`(<${tag}[^>]*>)([\\s\\S]*?)(</${tag}>)`, "i");
      if (regex.test(html)) {
        return html.replace(regex, `$1${content}$3`);
      } else {
        return html.replace(/<\/body>/i, `<${tag}>${content}</${tag}></body>`);
      }
    },
  };
}
