// Recipe loader and template assembler for sensorbox.
//
// Recipes are YAML files served by the selector nginx at /recipes/ (see
// sensorbox's compose.yaml and selector/generate-recipes-index.sh). This
// module is responsible for fetching them, parsing with js-yaml (loaded
// as a global via www/js/vendor/js-yaml.min.js), and rendering the final
// uci-defaults script with Mustache (also a global) from form values.
//
// Parsing and templating live in the browser — no preprocessing, no build
// step. Recipes are the source of truth at runtime.

import { show, hide } from "./utils.js";

const RECIPES_BASE = "/recipes";

export async function loadAllRecipes() {
  const indexRes = await fetch(`${RECIPES_BASE}/index.json`, {
    cache: "no-cache",
  });
  if (!indexRes.ok) {
    throw new Error(`fetch index.json: HTTP ${indexRes.status}`);
  }
  const index = await indexRes.json();

  const commonRes = await fetch(`${RECIPES_BASE}/${index.common}`, {
    cache: "no-cache",
  });
  if (!commonRes.ok) {
    throw new Error(`fetch ${index.common}: HTTP ${commonRes.status}`);
  }
  const common = window.jsyaml.load(await commonRes.text());
  await resolveSectionFiles(
    common,
    recipeFilesDir(index.common),
    fetchRecipeFile
  );

  const recipes = await Promise.all(
    index.recipes.map(async (name) => {
      const res = await fetch(`${RECIPES_BASE}/${name}`, { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(`fetch ${name}: HTTP ${res.status}`);
      }
      const parsed = window.jsyaml.load(await res.text());
      parsed._filename = name;
      await resolveSectionFiles(parsed, recipeFilesDir(name), fetchRecipeFile);
      return parsed;
    })
  );

  // Stable alphabetical order in the device dropdown.
  recipes.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  return { common, recipes };
}

async function fetchRecipeFile(relPath) {
  const res = await fetch(`${RECIPES_BASE}/${relPath}`, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`fetch ${relPath}: HTTP ${res.status}`);
  }
  return res.text();
}

// A recipe's `sections[].files` sources live in a directory named after
// the recipe file: friendlyarm_nanopi-zero2.yaml -> friendlyarm_nanopi-zero2/,
// _common.yaml -> _common/.
export function recipeFilesDir(filename) {
  return filename.replace(/\.ya?ml$/, "");
}

const FILE_PATH_RE = /^\/[A-Za-z0-9._+/-]+$/;
const FILE_MODE_RE = /^[0-7]{3,4}$/;

// Normalizes every `sections[].files` entry of a parsed recipe into
// {path, src, mode, template, content}, reading each source through
// `readText(relPath)`. Runs once at load time so assembleDefaults() can stay
// synchronous. `readText` is fetch() in the browser and fs in hwtest.
//
// In YAML a file is `/dest/path: src` or `/dest/path: {src, mode, template}`.
export async function resolveSectionFiles(doc, dir, readText) {
  if (!doc || !doc.sections) return doc;
  if (!Array.isArray(doc.sections)) {
    throw new Error(`${dir}: sections must be a list`);
  }
  for (const section of doc.sections) {
    const entries = Object.entries(section.files || {});
    section.files = await Promise.all(
      entries.map(async ([path, spec]) => {
        const f = typeof spec === "string" ? { src: spec } : { ...spec };
        if (!FILE_PATH_RE.test(path)) {
          throw new Error(`${dir}: bad file path ${JSON.stringify(path)}`);
        }
        if (
          typeof f.src !== "string" ||
          f.src.startsWith("/") ||
          f.src.split("/").includes("..")
        ) {
          throw new Error(`${dir}: ${path}: src must be a path inside ${dir}/`);
        }
        // A string, because YAML parsers disagree on what bare 0755 means.
        if (
          f.mode !== undefined &&
          (typeof f.mode !== "string" || !FILE_MODE_RE.test(f.mode))
        ) {
          throw new Error(
            `${dir}: ${path}: mode must be a quoted octal string like "0755"`
          );
        }
        return {
          path,
          src: f.src,
          mode: f.mode,
          template: f.template === true,
          content: await readText(`${dir}/${f.src}`),
        };
      })
    );
  }
  return doc;
}

// Mustache's notion of truthy, so `when: x` gates exactly like {{#x}}.
function isTruthy(value) {
  return Array.isArray(value) ? value.length > 0 : !!value;
}

const HEREDOC_DELIMITER = "SENSORBOX_FILE_EOF";

// Emits the shell that writes one file onto the device. Files are copied
// verbatim unless they opt into Mustache with `template: true`.
function renderFile(file, formValues) {
  let body = file.template
    ? window.Mustache.render(file.content, formValues)
    : file.content;
  if (!body.endsWith("\n")) body += "\n";
  if (body.split("\n").includes(HEREDOC_DELIMITER)) {
    throw new Error(
      `${file.src}: contains a line reading ${HEREDOC_DELIMITER}`
    );
  }
  const dir = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
  const lines = [
    `mkdir -p ${dir}`,
    `cat > ${file.path} <<'${HEREDOC_DELIMITER}'`,
    body + HEREDOC_DELIMITER,
  ];
  if (file.mode) lines.push(`chmod ${file.mode} ${file.path}`);
  return lines.join("\n");
}

// Renders a recipe's `defaults` followed by each of its `sections` whose
// `when` flag is set. A section writes its files first, then runs its own
// `defaults`, so that script can enable or chmod what it just installed.
function renderRecipeScript(doc, formValues) {
  const parts = [];
  if (doc.defaults) {
    parts.push(window.Mustache.render(doc.defaults, formValues));
  }
  for (const section of doc.sections || []) {
    if (section.when && !isTruthy(formValues[section.when])) continue;
    for (const file of section.files || []) {
      parts.push(renderFile(file, formValues));
    }
    if (section.defaults) {
      parts.push(window.Mustache.render(section.defaults, formValues));
    }
  }
  return parts.join("\n");
}

export function getRecipeById(recipes, id) {
  return recipes.find((r) => r.id === id);
}

// Returns an array of {label, href} link objects for the given recipe.
// Used in both the device-info area (on selection) and the download area
// (after build) so the user has reference links at every stage.
export function buildDeviceLinks(recipe) {
  const links = [];
  if (recipe && recipe.vendor_url) {
    links.push({ label: "Vendor docs", href: recipe.vendor_url });
  }
  return links;
}

// Renders device links into a container DOM element. Used in both the
// device-info area (on selection) and the download area (after build).
export function renderDeviceLinks(container, recipe) {
  container.innerHTML = "";
  const links = buildDeviceLinks(recipe);
  for (const link of links) {
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.label;
    a.target = "_blank";
    a.rel = "noopener";
    container.appendChild(a);
  }
  if (links.length) {
    show(container);
  } else {
    hide(container);
  }
}

// Returns the deduplicated union of _common.yaml's `packages`, the
// selected recipe's `packages`, and any packages contributed by the
// user's selected recipe options (e.g. Wi-Fi module choice).
// `selectedOptions` is an object like { wifi_module: "intel_be200" }
// mapping option names to chosen keys; each choice can declare a
// `packages` list in the recipe YAML.
export function mergedPackages(common, recipe, selectedOptions) {
  const commonPkgs = (common && common.packages) || [];
  const recipePkgs = (recipe && recipe.packages) || [];
  const optionPkgs = [];
  if (recipe && recipe.options && selectedOptions) {
    for (const [optName, choiceKey] of Object.entries(selectedOptions)) {
      const opt = recipe.options[optName];
      if (opt && opt.choices && opt.choices[choiceKey]) {
        const pkgs = opt.choices[choiceKey].packages || [];
        optionPkgs.push(...pkgs);
      }
    }
  }
  return Array.from(new Set([...commonPkgs, ...recipePkgs, ...optionPkgs]));
}

// Fetches each referenced public key file and returns the contents as
// an array of strings suitable for ASU's `repository_keys` field.
export async function resolveKeys(keyFilenames) {
  const contents = [];
  for (const name of keyFilenames) {
    const res = await fetch(`${RECIPES_BASE}/keys/${name}`, {
      cache: "no-cache",
    });
    if (!res.ok) {
      throw new Error(`fetch keys/${name}: HTTP ${res.status}`);
    }
    contents.push((await res.text()).trim());
  }
  return contents;
}

// Concatenates common pre-amble + recipe defaults + user-provided extra
// defaults into a single script, rendering Mustache templates against
// the form values. Mustache is a global loaded via vendor/mustache.min.js.
export function assembleDefaults(common, recipe, formValues, extraDefaults) {
  const parts = [
    "#!/bin/sh",
    "# Generated by sensorbox — runs once on first boot via /etc/uci-defaults/.",
    "",
  ];

  const commonScript = common ? renderRecipeScript(common, formValues) : "";
  if (commonScript) {
    parts.push("# --- sensorbox common pre-amble ---");
    parts.push(commonScript);
  }

  const recipeScript = recipe ? renderRecipeScript(recipe, formValues) : "";
  if (recipeScript) {
    parts.push(`# --- ${recipe.id} recipe ---`);
    parts.push(recipeScript);
  }

  if (extraDefaults && extraDefaults.trim()) {
    parts.push("# --- Additional uci-defaults (user-supplied) ---");
    parts.push(extraDefaults);
  }

  parts.push("exit 0");
  return parts.join("\n");
}
