// Entry point for the sensorbox variant of the firmware selector.
// Replaces the upstream device-picker flow with one driven by recipe YAML
// files served from /recipes/ (see sensorbox's recipes/ directory).

import { $, show, hide, showAlert, hideAlert } from "./utils.js";
import {
  loadAllRecipes,
  getRecipeById,
  renderDeviceLinks,
  mergedPackages,
  resolveKeys,
  assembleDefaults,
} from "./sensorbox-recipes.js";
import { submitBuild } from "./sensorbox-asu.js";

const state = {
  common: null,
  recipes: [],
  currentRecipe: null,
};

async function init() {
  hideAlert();

  try {
    const { common, recipes } = await loadAllRecipes();
    state.common = common;
    state.recipes = recipes;
  } catch (err) {
    showAlert(`Failed to load recipes: ${err.message}`);
    return;
  }

  if (state.recipes.length === 0) {
    showAlert(
      "No recipes found in /recipes/. Add a YAML file to sensorbox's recipes/ directory and recreate the selector service."
    );
    return;
  }

  populateDeviceDropdown();
  wireForm();
}

function populateDeviceDropdown() {
  const select = $("#sensorbox-device");
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.innerText = "Choose a device";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const recipe of state.recipes) {
    const opt = document.createElement("option");
    opt.value = recipe.id;
    opt.innerText = recipe.title || recipe.id;
    select.appendChild(opt);
  }
}

function wireForm() {
  const form = $("#sensorbox-form");
  const select = $("#sensorbox-device");

  select.addEventListener("change", () => {
    state.currentRecipe = getRecipeById(state.recipes, select.value);
    $("#sensorbox-device-description").innerText =
      state.currentRecipe?.description || "";

    renderDeviceLinks($("#sensorbox-device-links"), state.currentRecipe);

    // Recipe options (e.g. Wi-Fi module selection). Each option becomes
    // a labeled dropdown. Selections are collected at build time and
    // their packages merged into the request.
    renderOptions(state.currentRecipe);

    // Show Wi-Fi fields when the recipe has capabilities.wifi AND the
    // selected Wi-Fi module is not "none". If the recipe uses a
    // wifi_module option, the dropdown drives visibility; otherwise
    // capabilities.wifi alone controls it.
    const wifiGroup = $("#sensorbox-wifi-group");
    const updateWifiVisibility = () => {
      const moduleSelect = document.getElementById("sensorbox-opt-wifi_module");
      const hasWifi = state.currentRecipe?.capabilities?.wifi;
      const moduleSelected = !moduleSelect || moduleSelect.value !== "none";
      if (hasWifi && moduleSelected) {
        show(wifiGroup);
      } else {
        hide(wifiGroup);
      }
    };
    updateWifiVisibility();
    const moduleSelect = document.getElementById("sensorbox-opt-wifi_module");
    if (moduleSelect) {
      moduleSelect.addEventListener("change", updateWifiVisibility);
    }

    // Show the "Install to eMMC" group only for recipes that declare
    // an install block — recipes without one don't support the flow.
    // The hint text below the checkbox comes from the recipe's
    // install.hint field so recipe authors can note device-specific
    // caveats (e.g. "not all E20C models have eMMC").
    const installGroup = $("#sensorbox-install-group");
    if (state.currentRecipe?.install) {
      show(installGroup);
      $("#sensorbox-install-hint").innerText =
        state.currentRecipe.install.hint || "";
    } else {
      hide(installGroup);
    }
    validateForm();
  });

  form.addEventListener("input", validateForm);
  form.addEventListener("submit", onSubmit);

  // System telemetry: show/hide the URL/credentials sub-fields based
  // on the enable checkbox. Independent of recipe/device selection.
  const telemetryCheckbox = $("#sensorbox-telemetry-enabled");
  const telemetryFields = $("#sensorbox-telemetry-fields");
  telemetryCheckbox.addEventListener("change", () => {
    if (telemetryCheckbox.checked) {
      show(telemetryFields);
    } else {
      hide(telemetryFields);
    }
  });

  // Tailscale: show/hide the auth-key field based on the enable checkbox.
  const tailscaleCheckbox = $("#sensorbox-tailscale-enabled");
  const tailscaleFields = $("#sensorbox-tailscale-fields");
  tailscaleCheckbox.addEventListener("change", () => {
    if (tailscaleCheckbox.checked) {
      show(tailscaleFields);
    } else {
      hide(tailscaleFields);
    }
  });

  // Password show/hide toggles
  document.querySelectorAll(".sensorbox-toggle-pw").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.textContent = showing ? "show" : "hide";
      }
    });
  });

  validateForm();
}

function validateForm() {
  const device = $("#sensorbox-device").value;
  const token = $("#sensorbox-token").value.trim();
  const rootPw = $("#sensorbox-root-password").value;
  const valid = !!device && !!token && !!rootPw;
  $("#sensorbox-build").disabled = !valid;
  return valid;
}

async function onSubmit(e) {
  e.preventDefault();
  if (!validateForm()) return;

  const recipe = state.currentRecipe;
  if (!recipe) return;

  // If the recipe uses a custom branch (custom-built ImageBuilder),
  // check the builder API to ensure it's ready before submitting to
  // ASU. If not ready, trigger a build and poll until complete.
  if (recipe.custom_branch) {
    const statusEl = $("#sensorbox-status");
    show(statusEl);
    statusEl.innerText = "Checking custom ImageBuilder status...";
    statusEl.classList.remove(
      "sensorbox-status-error",
      "sensorbox-status-success"
    );

    try {
      let res = await fetch(`/builder/status/${recipe.custom_branch}`);
      let status = await res.json();

      if (!status.ready) {
        if (!status.building) {
          // Trigger the build
          await fetch(`/builder/build/${recipe.custom_branch}`, {
            method: "POST",
          });
          statusEl.innerText =
            "Building custom ImageBuilder — this takes ~45 minutes...";
        }

        // Poll until ready
        while (!status.ready) {
          if (status.building) {
            const elapsed = Math.floor((status.elapsed_seconds || 0) / 60);
            const eta = status.eta_minutes || "?";
            statusEl.innerText = `Building custom ImageBuilder... ${elapsed}m elapsed, ~${eta}m remaining`;
          } else if (status.error) {
            statusEl.innerText = `ImageBuilder build failed: ${status.error}`;
            statusEl.classList.add("sensorbox-status-error");
            $("#sensorbox-build").disabled = false;
            return;
          }
          await new Promise((r) => setTimeout(r, 10000));
          res = await fetch(`/builder/status/${recipe.custom_branch}`);
          status = await res.json();
        }
        statusEl.innerText = "Custom ImageBuilder ready. Submitting build...";
      }
    } catch (err) {
      statusEl.innerText = `Builder check failed: ${err.message}`;
      statusEl.classList.add("sensorbox-status-error");
      $("#sensorbox-build").disabled = false;
      return;
    }
  }

  // Resolve repository keys BEFORE assembling the defaults script so
  // the first key (by convention: the Orb apk signing key) can be
  // Mustache-substituted into _common.yaml's feed-persistence block.
  let keyContents;
  try {
    keyContents = await resolveKeys(recipe.repository_keys || []);
  } catch (err) {
    showAlert(`Failed to load repository keys: ${err.message}`);
    return;
  }

  // The install-to-eMMC checkbox is only meaningful when the selected
  // recipe declares an install block — otherwise we force it false so
  // _common.yaml's {{#install_to_emmc}} section doesn't render.
  const installBlock = recipe.install || null;
  const installToEmmc =
    !!installBlock && $("#sensorbox-install-to-emmc").checked;

  // Selected recipe options (e.g. {wifi_module: "intel_be200"}).
  // Used both for package merging and to look up the chosen Wi-Fi
  // module's optional wifi_temp_probe override snippet.
  const selectedOptions = collectSelectedOptions(recipe);
  const wifiModuleKey = selectedOptions.wifi_module;
  const wifiTempProbeOverride =
    recipe.options?.wifi_module?.choices?.[wifiModuleKey]?.wifi_temp_probe ||
    "";

  // Telemetry: only meaningful when the enable checkbox is checked.
  // Empty fields are tolerated (trust the user); a misconfigured
  // telegraf will just retry-and-fail at runtime, no build-time block.
  const telemetryEnabled = $("#sensorbox-telemetry-enabled").checked;
  const tailscaleEnabled = $("#sensorbox-tailscale-enabled").checked;
  const tailscaleAuthKey = $("#sensorbox-tailscale-authkey").value.trim();
  // usb_diagnostic = enabled (Zero2 only, today) bundles WiFi Explorer
  // Pro's remote-sensor support — wlanpi user + sudoers + setcap.
  // Scandump is the tool WEPro actually drives, so usb_diagnostic
  // implies scandump_enabled. The Zero2 recipe's usb_diagnostic
  // section relies on the /usr/bin/scandump wrapper that the
  // _common.yaml {{#scandump_enabled}} block installs.
  const usbDiagnosticEnabled = selectedOptions.usb_diagnostic === "enabled";
  const scandumpEnabled =
    $("#sensorbox-scandump-enabled").checked || usbDiagnosticEnabled;
  // scandump implies docker — the wrapper is just `docker run ...`.
  // Treat the scandump checkbox as a docker-enabled superset to avoid
  // shipping a broken /usr/bin/scandump with no docker to back it.
  const dockerEnabled =
    $("#sensorbox-docker-enabled").checked || scandumpEnabled;

  const formValues = {
    orb_token: $("#sensorbox-token").value.trim(),
    root_password: $("#sensorbox-root-password").value,
    // First resolved key is assumed to be the Orb apk signing key.
    // _common.yaml writes it to /etc/apk/keys/orb-packages.pem so
    // the running device can verify new Orb versions fetched by
    // orb-update. Recipes must list the Orb key first in
    // repository_keys — enforced by convention, not schema, today.
    orb_apk_key: keyContents[0] || "",
    // Wi-Fi config — only meaningful for recipes with capabilities.wifi.
    // The recipe's defaults template uses {{#wifi_ssid}} as a section
    // guard so the whole Wi-Fi block is omitted when SSID is empty.
    wifi_ssid: $("#sensorbox-wifi-ssid").value.trim(),
    wifi_password: $("#sensorbox-wifi-password").value,
    wifi_encryption: $("#sensorbox-wifi-encryption").value,
    wifi_country: ($("#sensorbox-wifi-country").value || "US")
      .toUpperCase()
      .trim(),
    // Band lock: "auto" roams across all bands via scan_list;
    // locked bands set the radio directly with no scan_list.
    wifi_band_auto: $("#sensorbox-wifi-band").value === "auto",
    wifi_radio_band:
      {
        auto: "5g",
        "2g": "2g",
        "5g": "5g",
        "6g": "6g",
      }[$("#sensorbox-wifi-band").value] || "5g",
    wifi_radio_htmode:
      {
        auto: "HE80",
        "2g": "HE20",
        "5g": "HE80",
        "6g": "EHT80",
      }[$("#sensorbox-wifi-band").value] || "HE80",
    // Installer config — mirrored from the recipe's install block
    // into flat Mustache variables that _common.yaml's installer
    // heredoc interpolates. Empty strings when the recipe has no
    // install block (in which case install_to_emmc is also false
    // and the whole block gets elided by the Mustache section).
    install_to_emmc: installToEmmc,
    install_sd_device: installBlock?.sd_device || "",
    install_emmc_device: installBlock?.emmc_device || "",
    install_size_from_partition: installBlock?.size_from_partition || "",
    install_status_led: installBlock?.status_led || "",
    // System telemetry — _common.yaml's {{#telemetry_enabled}} section
    // wraps the entire telegraf install/config block.
    telemetry_enabled: telemetryEnabled,
    telemetry_url: $("#sensorbox-telemetry-url").value.trim(),
    telemetry_username: $("#sensorbox-telemetry-username").value.trim(),
    telemetry_password: $("#sensorbox-telemetry-password").value,
    telemetry_include_wireless: $("#sensorbox-telemetry-include-wireless")
      .checked,
    // Verbatim shell snippet from the selected Wi-Fi module's
    // wifi_temp_probe field (if any). Substituted into the wifi-temp.sh
    // helper ahead of the generic hwmon scan; if it `exit 0`s on
    // success, the generic scan is skipped.
    wifi_temp_probe_override: wifiTempProbeOverride,
    // Tailscale — _common.yaml's {{#tailscale_enabled}} section runs
    // `tailscale up --auth-key=... --hostname=<Orb-NNNN> --ssh` on
    // first boot. Auth key is the only user-supplied value.
    tailscale_enabled: tailscaleEnabled,
    tailscale_auth_key: tailscaleAuthKey,
    // Docker — _common.yaml's {{#docker_enabled}} section enables
    // the dockerd init.d so the daemon starts at boot. The userspace
    // packages (dockerd, docker CLI, docker-compose) come in via the
    // build request's package list; on the Zero2 the required kmods
    // are baked in via zero2.defconfig, on stock-kernel boards they
    // come from upstream feeds.
    docker_enabled: dockerEnabled,
    // scandump — _common.yaml's {{#scandump_enabled}} section installs
    // a /usr/bin/scandump wrapper around the ghcr.io/dboze/scandump
    // container, plus a one-shot init.d that pre-pulls the image when
    // network comes up. Implies docker_enabled (the wrapper is a thin
    // `docker run ...`).
    scandump_enabled: scandumpEnabled,
  };

  // Expose every recipe option's selected choice as a Mustache boolean
  // so templates can gate sections with `{{#optname_choicekey}}...{{/...}}`.
  // For each option, the chosen key is true and every other key is false.
  // Lets the recipe author write {{#usb_diagnostic_enabled}} or
  // {{^wifi_module_none}} without the selector needing to know about
  // each specific option name.
  if (recipe.options) {
    for (const [optName, opt] of Object.entries(recipe.options)) {
      const chosen = selectedOptions[optName];
      for (const choiceKey of Object.keys(opt.choices || {})) {
        formValues[`${optName}_${choiceKey}`] = choiceKey === chosen;
      }
    }
  }
  const extraDefaults = $("#sensorbox-extra-defaults").value;

  const defaultsScript = assembleDefaults(
    state.common,
    recipe,
    formValues,
    extraDefaults
  );

  const buildRequest = {
    distro: "openwrt",
    version: recipe.version,
    target: recipe.target,
    profile: recipe.profile,
    // Packages sent to ASU is the union of _common.yaml's packages
    // (sensorbox-wide dependencies like micrond for orb-update's
    // cron) and the selected recipe's packages (device-specific
    // extras like orb). This is a list of ADDITIONS on top of the
    // profile's default packages — NOT a complete replacement list.
    // diff_packages MUST be false for this semantics: when true, ASU
    // interprets the list as a full override and silently removes
    // every profile default not in it, stripping base-files and a
    // bunch of busybox applets. That's the upstream selector's mode
    // (it pre-fills a textarea with the full default list), but it's
    // the wrong shape for a recipe system.
    packages: [
      ...mergedPackages(state.common, recipe, selectedOptions),
      // telegraf-full ships all input/output plugins. The lite "telegraf"
      // package omits temp, wireless, and others we use, causing telegraf
      // to bail at startup with "undefined but requested input".
      ...(telemetryEnabled ? ["telegraf-full"] : []),
      // tailscale package: the daemon + CLI for joining the tailnet.
      ...(tailscaleEnabled ? ["tailscale"] : []),
      // docker package set: dockerd daemon + docker CLI + compose plugin.
      // Upstream OpenWrt apk package names are "dockerd" / "docker" /
      // "docker-compose" — not the docker.com "docker-ce" naming.
      // dockerd pulls in its own kmod deps (kmod-veth, kmod-ipt-nat, etc.);
      // on Zero2 those are pre-built locally via zero2.defconfig, on
      // stock-kernel devices they come from upstream apk feeds.
      ...(dockerEnabled ? ["dockerd", "docker", "docker-compose"] : []),
    ],
    diff_packages: false,
    repositories: recipe.repositories || {},
    repositories_mode: "append",
    repository_keys: keyContents,
    defaults: defaultsScript,
  };

  submitBuild(buildRequest, recipe);
}

// Renders recipe options (e.g. Wi-Fi module selection) as labeled
// dropdowns in the #sensorbox-options container. Each option defined in
// recipe.options becomes a <select> with id="sensorbox-opt-{name}".
function renderOptions(recipe) {
  const container = $("#sensorbox-options");
  container.innerHTML = "";
  if (!recipe || !recipe.options) return;

  for (const [name, opt] of Object.entries(recipe.options)) {
    const div = document.createElement("div");

    const label = document.createElement("label");
    label.setAttribute("for", `sensorbox-opt-${name}`);
    label.textContent = opt.label || name;
    div.appendChild(label);

    const select = document.createElement("select");
    select.id = `sensorbox-opt-${name}`;
    for (const [key, choice] of Object.entries(opt.choices || {})) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = choice.label || key;
      if (key === (opt.default || "")) option.selected = true;
      select.appendChild(option);
    }
    div.appendChild(select);

    container.appendChild(div);
  }
}

// Reads the current selection from each recipe-option dropdown and
// returns an object like { wifi_module: "intel_be200" }.
function collectSelectedOptions(recipe) {
  const result = {};
  if (!recipe || !recipe.options) return result;
  for (const name of Object.keys(recipe.options)) {
    const el = document.getElementById(`sensorbox-opt-${name}`);
    if (el) result[name] = el.value;
  }
  return result;
}

document.addEventListener("DOMContentLoaded", init);
