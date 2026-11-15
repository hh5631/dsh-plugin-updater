window.__ModuleLoader__.load({
  id: "dsh-plugin-updater",
  factory: (require) => {
    const { createElement: h, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = require("react");
    const { createPortal } = require("react-dom");
    const { Button, IconRefreshOutlineRegular, Modal, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
    const PANEL = "[data-plugin-panel]";
    const GROUP = '[data-plugin-group="bundles"]';
    const PACKAGE = "[data-plugin-package]";
    const ROUTE = "/dsh-plugin-updater/api";

    function useTargets(active) {
      const [targets, setTargets] = useState([]);
      useLayoutEffect(() => {
        if (!active) return;
        let panel;
        let frame;
        function read() {
          frame = undefined;
          panel = document.querySelector(PANEL);
          const group = panel?.querySelector(GROUP);
          const heading = group?.querySelector(':scope > [class$="_groupHead"]');
          const next = heading ? [heading, ...group.querySelectorAll(`${PACKAGE} > div > [class$="_cardEnd"]`)] : [];
          setTargets((previous) => previous.length === next.length
            && previous.every((element, index) => element === next[index]) ? previous : next);
        }
        // The installed bundle list has no action slot.
        const observer = new MutationObserver((records) => {
          if (frame !== undefined) return;
          if (!panel?.isConnected || records.some(({ target }) => panel.contains(target))) {
            frame = requestAnimationFrame(read);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        read();
        return () => {
          observer.disconnect();
          if (frame !== undefined) cancelAnimationFrame(frame);
        };
      }, [active]);
      return targets;
    }

    function githubPackage(pkg) {
      return pkg.installed && pkg.availability === "profile" && !pkg.official && !pkg.readOnlyReason && pkg.version && pkg.update !== "registry"
        && /^(?:github:|git@github\.com:|(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com\/[^/]+\/[^/#]+(?:\/?(?:#.*)?$|\/releases\/(?:latest\/download|download\/[^/]+)\/[^/]+\.(?:tgz|tar\.gz)(?:#.*)?$))/i.test(pkg.source ?? "");
    }

    async function request(action, pkg, version) {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, name: pkg.name, from: pkg.version, version }),
        ...(action === "check" ? { signal: AbortSignal.timeout(30_000) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      return result;
    }

    async function runPool(items, limit, task) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
        while (next < items.length) await task(items[next++]);
      }));
    }

    function apply(ctx) {
      const t = ctx.locale.bind("pluginManager");
      const subscribeLocale = (fn) => ctx.locale.subscribe(fn);
      const getLanguage = () => ctx.locale.getSnapshot().active;
      const subscribePanel = (fn) => ctx.layout.panelInfo.subscribe(fn);
      const getPanel = () => ctx.layout.panelInfo.getSnapshot().activePanelId;
      const subscribeEntry = (fn) => ctx.slots.subscribe("main", fn);
      const getEntry = () => ctx.slots.entries("main").find(({ options }) => options.key === "plugins");

      function Actions({ face, active }) {
        const { packages, refreshStatus, busy, install, update, confirm } =
          useSyncExternalStore(face.hooks.pluginManager.subscribe, face.hooks.pluginManager.getSnapshot);
        const zh = useSyncExternalStore(subscribeLocale, getLanguage) === "zh";
        const [heading, ...rows] = useTargets(active);
        const [results, setResults] = useState({});
        const [checking, setChecking] = useState(null);
        const [selection, setSelection] = useState(null);
        const [updating, setUpdating] = useState(null);
        const [feedback, setFeedback] = useState(null);
        const inFlight = useRef({ check: false, update: false, updateStarted: false });

        const eligible = useMemo(() => packages.filter(githubPackage), [packages]);
        const byName = useMemo(() => new Map(packages.map((pkg) => [pkg.name, pkg])), [packages]);
        const resultOf = (pkg) => {
          const result = results[pkg.name];
          return result && result.from === pkg.version && result.source === pkg.source ? result : undefined;
        };
        const available = eligible.flatMap((pkg) => {
          const target = resultOf(pkg)?.target;
          return target ? [{ pkg, target }] : [];
        });
        const managing = refreshStatus === "refreshing" || update !== null || install.open
          || install.requestId !== undefined || confirm !== null || busy.length > 0;

        async function checkAll() {
          const job = inFlight.current;
          if (job.check || job.update || managing) return;
          job.check = true;
          job.updateStarted = false;
          const total = eligible.length;
          let done = 0;
          let failed = 0;
          let found = 0;
          setFeedback(null);
          setChecking({ done, total });
          async function check(pkg) {
            let result;
            try {
              result = await request("check", pkg);
              if (result.target) found++;
            } catch (error) {
              failed++;
              result = { error: error.message };
            }
            setResults((old) => ({ ...old, [pkg.name]: { from: pkg.version, source: pkg.source, ...result } }));
            setChecking({ done: ++done, total });
          }
          try {
            await runPool(eligible, 6, check);
            if (!job.updateStarted) setFeedback({ check: true, failed, found });
          } finally {
            job.check = false;
            setChecking(null);
          }
        }

        async function applyUpdates() {
          const job = inFlight.current;
          if (!selection || job.update || managing) return;
          job.update = true;
          job.updateStarted = true;
          const total = selection.length;
          let failed = 0;
          let restart = 0;
          setFeedback(null);
          setSelection(null);
          setUpdating({ done: 0, total, names: new Set(selection.map(({ pkg }) => pkg.name)) });
          try {
            await runPool(selection, 3, async ({ pkg, target }) => {
              try {
                const result = await request("update", pkg, target.version);
                if (result.restart) restart++;
                setResults((old) => ({ ...old, [pkg.name]: { from: pkg.version, source: pkg.source } }));
              } catch (error) {
                failed++;
                setResults((old) => ({ ...old, [pkg.name]: { from: pkg.version, source: pkg.source, target, error: error.message } }));
              }
              setUpdating((previous) => {
                const names = new Set(previous.names);
                names.delete(pkg.name);
                return { done: previous.done + 1, total, names };
              });
            });
            setFeedback({ failed, done: total, restart });
          } finally {
            job.update = false;
            setUpdating(null);
          }
        }

        if (!active || !heading || eligible.length === 0) return null;
        const checkLabel = zh ? "检查 GitHub 更新" : "Check GitHub updates";
        const updateAllLabel = zh ? `全部更新 (${available.length})` : `Update all (${available.length})`;
        let status = "";
        if (updating) {
          status = zh ? `正在更新 ${updating.done}/${updating.total}` : `Updating ${updating.done}/${updating.total}`;
        } else if (feedback?.check) {
          if (feedback.failed) {
            status = zh ? `${feedback.found} 个可更新，${feedback.failed} 个检查失败` : `${feedback.found} available, ${feedback.failed} checks failed`;
          } else if (!feedback.found) {
            status = zh ? "未发现可用更新" : "No updates found";
          }
        } else if (feedback) {
          status = zh ? `已更新 ${feedback.done - feedback.failed}/${feedback.done}` : `Updated ${feedback.done - feedback.failed}/${feedback.done}`;
          if (feedback.failed) status += zh ? `，${feedback.failed} 个失败` : `, ${feedback.failed} failed`;
          if (feedback.restart) status += zh ? "，重启 DSH 后生效" : ", restart DSH to apply";
        }
        const controls = createPortal(h("div", {
          style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" },
        },
        h("span", { role: "status", style: { fontSize: "12px" } }, status),
        available.length > 1 && h(Button, {
          variant: "outline", size: "sm", disabled: !!(managing || updating || selection),
          onClick: () => setSelection(available),
          children: updateAllLabel,
        }),
        h(Button, {
          variant: "outline", size: "sm", disabled: !!(checking || updating || managing || selection),
          "aria-busy": !!checking,
          icon: checking ? h(StateDot, { state: "ongoing", size: 13 }) : h(IconRefreshOutlineRegular, { size: 13 }),
          onClick: checkAll,
          children: checking ? `${t("versionsChecking")} ${checking.done}/${checking.total}` : checkLabel,
        })), heading, "controls");

        const actions = rows.map((container) => {
          const name = container.closest(PACKAGE)?.getAttribute("data-plugin-package");
          const pkg = byName.get(name);
          if (!pkg) return null;
          const result = resultOf(pkg);
          const queued = updating?.names.has(name);
          const noUpdate = result?.target === null;
          if (!queued && !noUpdate && !result?.target && !result?.error) return null;
          const label = result?.target ? t("versionsUpdateLabel", { version: result.target.version }) : "";
          const errorLabel = zh ? "检查失败" : "Check failed";
          return createPortal(h("div", {
            style: { order: -1, display: "flex", gap: "5px", alignItems: "center", whiteSpace: "nowrap" },
          },
          result?.error && !queued && h("span", {
            title: result.error, "aria-label": result.error, tabIndex: 0, style: { fontSize: "12px" },
          }, h(StateDot, { state: "error", size: 12 }), " ", result.target ? (zh ? "更新失败" : "Update failed") : errorLabel),
          noUpdate && !queued && h("span", { style: { fontSize: "12px" } }, zh ? "无可用更新" : "No update available"),
          queued ? h(StateDot, { state: "ongoing", size: 13 }) : result?.target && h(Button, {
            variant: "ghost",
            size: "sm",
            title: label,
            "aria-label": `${name} · ${label}`,
            disabled: !!(managing || updating || selection),
            onClick: () => setSelection([{ pkg, target: result.target }]),
            children: label,
          })), container, name);
        });

        const dialog = selection && h(Modal, {
          key: "confirm-update",
          open: true,
          onClose: () => setSelection(null),
          title: selection.length === 1 ? t("updateTitle", { name: selection[0].pkg.name }) : updateAllLabel,
          closeLabel: t("close"),
          footer: [
            h(Button, { key: "cancel", variant: "outline", onClick: () => setSelection(null) }, t("cancel")),
            h(Button, { key: "update", variant: "primary", disabled: managing, onClick: applyUpdates }, t("update")),
          ],
        }, h("ul", { style: { margin: 0, paddingInlineStart: "1.25em", maxHeight: "45vh", overflow: "auto" } },
          selection.map(({ pkg, target }) => h("li", { key: pkg.name },
            `${pkg.name} · ${pkg.version} → ${target.version}${target.repository ? ` · ${target.repository}` : ""}`))));
        return [controls, ...actions, dialog];
      }

      function PluginOverlay() {
        const panel = useSyncExternalStore(subscribePanel, getPanel);
        const entry = useSyncExternalStore(subscribeEntry, getEntry);
        const face = useMemo(() => entry?.inject?.(), [entry]);
        if (!face?.hooks?.pluginManager) return null;
        return h(Actions, { face, active: panel === "plugins" });
      }

      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-plugin-updater",
      }, PluginOverlay)), "dsh-plugin-updater: installed list actions");
    }

    return { apply, inject: ["slots", "layout", "locale"] };
  },
});
