window.__ModuleLoader__.load({
  id: "dsh-plugin-updater",
  factory: (require) => {
    const { createElement: h, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = require("react");
    const { createPortal } = require("react-dom");
    const { Button, IconCheckOutlineRegular, IconRefreshOutlineRegular, Modal, StateDot } =
      require("@deepseek-ai/dsh-client-ui-primitives");
    const PANEL = "[data-plugin-panel]";
    const GROUP = '[data-plugin-group="bundles"]';
    const PACKAGE = "[data-plugin-package]";
    const ROUTE = "/dsh-plugin-updater/api";
    const CHECK_CONCURRENCY = 6;
    const UPDATE_CONCURRENCY = 3;
    const messageOf = (error) => (error instanceof Error ? error.message : String(error));

    // The native plugin page declares no action slot for an installed bundle row, so these controls are portaled
    // into that row's action area. A single small stylesheet, keyed by id and written once, lets them follow the
    // page's own tokens for type, spacing, and focus instead of inline styles that cannot express hover or dark mode.
    const STYLE_ID = "dsh-plugin-updater-controls";
    const CSS = ".dpu-head { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; min-width: 0; }\n.dpu-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }\n.dpu-status[data-tone=\"info\"] { color: var(--dsw-alias-state-business-primary); }\n.dpu-status[data-tone=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n.dpu-statusMore { padding: 0; border: 0; border-radius: 4px; background: none; font: inherit; cursor: pointer; transition: color 140ms ease, text-decoration-color 140ms ease; }\n.dpu-statusMore:hover { text-decoration: underline; }\n.dpu-statusMore:active { opacity: 0.72; }\n.dpu-statusMore:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }\n.dpu-row { order: -1; display: inline-flex; align-items: center; gap: 6px; min-height: 24px; white-space: nowrap; }\n.dpu-rowLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }\n.dpu-target { display: inline-flex; align-items: center; gap: 6px; }\n.dpu-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; font-size: 10px; line-height: 1; letter-spacing: 0.01em; color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }\n.dpu-fail { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); cursor: help; transition: opacity 140ms ease; }\nbutton.dpu-fail:hover { text-decoration: underline; }\nbutton.dpu-fail:active { opacity: 0.72; }\n.dpu-fail:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-error-primary)); outline-offset: 2px; }\n.dpu-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; max-height: 45vh; overflow: auto; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }\n.dpu-item { display: flex; align-items: flex-start; gap: 8px; }\n.dpu-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 14px; height: 18px; color: var(--dsw-alias-state-success-primary); }\n.dpu-glyph[data-tone=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n.dpu-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\n.dpu-name { font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }\n.dpu-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }\n.dpu-detail[data-tone=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n@media (prefers-reduced-motion: reduce) { .dpu-statusMore, .dpu-fail { transition: none; } }";

    let styled = false;
    function useStyles() {
      useLayoutEffect(() => {
        if (styled || document.getElementById(STYLE_ID)) {
          styled = true;
          return;
        }
        const element = document.createElement("style");
        element.id = STYLE_ID;
        element.textContent = CSS;
        document.head.append(element);
        styled = true;
      }, []);
    }

    function useTargets(active) {
      const [targets, setTargets] = useState([]);
      useLayoutEffect(() => {
        if (!active) return;
        let panel;
        let group;
        let frame;
        let timer;
        let watched = null;
        let observer;
        function publish() {
          frame = undefined;
          panel = document.querySelector(PANEL) ?? undefined;
          group = panel?.querySelector(GROUP) ?? undefined;
          const heading = group?.querySelector(':scope > [class$="_groupHead"]');
          const next = heading ? [heading, ...group.querySelectorAll(`${PACKAGE} > div > [class$="_cardEnd"]`)] : [];
          setTargets((previous) => previous.length === next.length
            && previous.every((element, index) => element === next[index]) ? previous : next);
          watch();
        }
        function schedule() {
          if (frame === undefined) frame = requestAnimationFrame(publish);
        }
        // Only the narrowest subtree that can add, remove, or replace a row is observed. Observing all of
        // document.body made every streamed token in the chat schedule a frame here; while the panel is absent,
        // a body change matters only if it mounted the panel, which a coarse timer answers soon enough.
        function watch() {
          const root = group ?? panel ?? document.body;
          if (root === watched) return;
          observer?.disconnect();
          watched = root;
          observer = new MutationObserver((records) => {
            if (root === document.body) {
              if (frame !== undefined || timer !== undefined) return;
              timer = setTimeout(() => {
                timer = undefined;
                schedule();
              }, 200);
              return;
            }
            if (frame !== undefined) return;
            if (!document.contains(root) || records.some(({ target }) => root.contains(target))) schedule();
          });
          observer.observe(root, { childList: true, subtree: true });
        }
        watch();
        publish();
        return () => {
          observer?.disconnect();
          if (frame !== undefined) cancelAnimationFrame(frame);
          if (timer !== undefined) clearTimeout(timer);
        };
      }, [active]);
      return targets;
    }

    function githubPackage(pkg) {
      return pkg.installed && pkg.availability === "profile" && !pkg.official && !pkg.readOnlyReason && pkg.version && pkg.update !== "registry"
        && /^(?:github:|git@github\.com:|(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?github\.com\/[^/]+\/[^/#]+(?:\/?(?:#.*)?$|\/releases\/(?:latest\/download|download\/[^/]+)\/[^/]+\.(?:tgz|tar\.gz)(?:#.*)?$))/i.test(pkg.source ?? "");
    }

    const CHECK_TIMEOUT = 30_000;
    // An install has no reply until pnpm finishes and reloads the profile, so this is only a watchdog against a
    // wedged route: without it a dead request would leave the dialog saying "updating" forever.
    const UPDATE_TIMEOUT = 15 * 60_000;
    const timedOut = (error) => error?.name === "AbortError" || error?.name === "TimeoutError";

    async function request(action, pkg, version) {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, name: pkg.name, from: pkg.version, version }),
        signal: AbortSignal.timeout(action === "check" ? CHECK_TIMEOUT : UPDATE_TIMEOUT),
      });
      // A truncated or non-JSON body must read as a failure, not as an answer with no update.
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      if (!body) throw new Error(`HTTP ${response.status}: unreadable answer`);
      return body;
    }

    // A scan hits a local route, so a transient fetch failure (route not yet mounted, laptop waking up) is
    // worth one quiet retry; an answer carrying an error is final and is never retried.
    async function check(pkg) {
      try {
        return await request("check", pkg);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400));
        return request("check", pkg);
      }
    }

    async function runPool(items, limit, task) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
        while (next < items.length) await task(items[next++]);
      }));
    }

    function Glyph({ state }) {
      if (state === "pending" || state === "running") {
        return h("span", { className: "dpu-glyph" }, h(StateDot, { state: "ongoing", size: 13 }));
      }
      if (state === "failed") {
        return h("span", { className: "dpu-glyph", "data-tone": "error" }, h(StateDot, { state: "error", size: 13 }));
      }
      return h("span", { className: "dpu-glyph", "aria-hidden": "true" }, h(IconCheckOutlineRegular, { size: 13 }));
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
        // One update run: the versions chosen for it, and the state each package last reported.
        const [run, setRun] = useState(null);
        // The run's dialog can be dismissed while it keeps going; the toolbar sentence reopens it.
        const [dialogOpen, setDialogOpen] = useState(false);
        const [feedback, setFeedback] = useState(null);
        const [problems, setProblems] = useState(null);
        const inFlight = useRef({ check: false, update: false, updateStarted: false, pending: null, timer: undefined });

        useStyles();

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
        const running = run?.phase === "running";
        // Only a live run holds the controls; a finished one leaves its outcome in place until the next check.
        const locked = !!(managing || checking || running);

        // A scan answers in bursts. Collecting row results and the progress counter in a short window paints each
        // burst once instead of re-rendering the portaled controls and the toolbar for every single answer.
        function flushResults() {
          const job = inFlight.current;
          if (job.timer !== undefined) {
            clearTimeout(job.timer);
            job.timer = undefined;
          }
          const pending = job.pending;
          const progress = job.progress;
          job.pending = null;
          job.progress = undefined;
          if (pending) setResults((old) => ({ ...old, ...pending }));
          if (progress) setChecking(progress);
        }
        function queueResult(name, value) {
          const job = inFlight.current;
          job.pending = { ...(job.pending ?? {}), [name]: value };
          if (job.timer !== undefined) return;
          job.timer = setTimeout(() => {
            job.timer = undefined;
            flushResults();
          }, 60);
        }

        async function checkAll() {
          const job = inFlight.current;
          if (job.check || job.update || managing) return;
          job.check = true;
          job.updateStarted = false;
          const total = eligible.length;
          const failures = [];
          let done = 0;
          let found = 0;
          setFeedback(null);
          // A finished run's rows give way to the fresh answers instead of masking them.
          setRun(null);
          setDialogOpen(false);
          setChecking({ done, total });
          async function collect(pkg) {
            let result;
            try {
              result = await check(pkg);
              if (result.target) found++;
            } catch (error) {
              const message = timedOut(error)
                ? (zh ? "检查超时，请稍后重试" : "The check timed out; try again later")
                : messageOf(error);
              failures.push({ name: pkg.name, message });
              result = { error: message };
            }
            queueResult(pkg.name, { from: pkg.version, source: pkg.source, ...result });
            job.progress = { done: ++done, total };
          }
          try {
            await runPool(eligible, CHECK_CONCURRENCY, collect);
            flushResults();
            if (!job.updateStarted) setFeedback({ kind: "check", found, failures });
          } finally {
            flushResults();
            job.check = false;
            setChecking(null);
          }
        }

        async function startUpdates(items) {
          const job = inFlight.current;
          if (job.update || managing) return;
          job.update = true;
          job.updateStarted = true;
          const failures = [];
          let restart = 0;
          setFeedback(null);
          setDialogOpen(true);
          setRun({ phase: "running", items: items.map(({ pkg, target }) => ({ pkg, target, state: "pending" })) });
          const mark = (name, state) => setRun((previous) => previous && {
            ...previous,
            items: previous.items.map((item) => item.pkg.name === name ? { ...item, state } : item),
          });
          try {
            await runPool(items, UPDATE_CONCURRENCY, async ({ pkg, target }) => {
              mark(pkg.name, "running");
              let state = "done";
              try {
                const result = await request("update", pkg, target.version);
                if (result.restart) restart++;
                queueResult(pkg.name, { from: pkg.version, source: pkg.source });
              } catch (error) {
                state = "failed";
                const message = timedOut(error)
                  ? (zh ? "更新等待超时，请检查插件列表后重试" : "The update timed out; check the plugin list and try again")
                  : messageOf(error);
                failures.push({ name: pkg.name, message });
                queueResult(pkg.name, { from: pkg.version, source: pkg.source, target, error: message });
              }
              mark(pkg.name, state);
            });
            flushResults();
            setRun((previous) => previous && { ...previous, phase: "done" });
            setFeedback({ kind: "update", failed: failures.length, done: items.length, restart, failures });
          } finally {
            flushResults();
            job.update = false;
          }
        }

        if (!active || !heading || eligible.length === 0) return null;

        const settled = run ? run.items.filter(({ state }) => state === "done" || state === "failed").length : 0;
        let status = "";
        let tone;
        if (running) {
          status = zh ? `正在更新 ${settled}/${run.items.length}` : `Updating ${settled}/${run.items.length}`;
          tone = "info";
        } else if (feedback?.kind === "check") {
          if (feedback.failures.length) {
            status = zh
              ? `${feedback.found} 个可更新，${feedback.failures.length} 个检查失败`
              : `${feedback.found} available, ${feedback.failures.length} checks failed`;
            tone = "error";
          } else if (!feedback.found) {
            status = zh ? "未发现可用更新" : "No updates found";
          } else {
            status = zh ? `${feedback.found} 个可更新` : `${feedback.found} available`;
            tone = "info";
          }
        } else if (feedback?.kind === "update") {
          status = zh
            ? `已更新 ${feedback.done - feedback.failed}/${feedback.done}`
            : `Updated ${feedback.done - feedback.failed}/${feedback.done}`;
          if (feedback.failed) {
            status += zh ? `，${feedback.failed} 个失败` : `, ${feedback.failed} failed`;
            tone = "error";
          }
          if (feedback.restart) status += zh ? "，重启 DSH 后生效" : ", restart DSH to apply";
        }
        const failures = feedback?.failures ?? [];
        // The sentence is also the way back to the details it summarizes: the failures behind it, or the run
        // it counts while the dialog is closed.
        const reopen = running && !dialogOpen
          ? { title: zh ? "查看更新进度" : "Show update progress", onClick: () => setDialogOpen(true) }
          : failures.length
            ? {
              title: zh ? "查看失败详情" : "Show failure details",
              onClick: () => setProblems({
                title: feedback.kind === "check"
                  ? (zh ? "这些插件检查失败" : "These checks failed")
                  : (zh ? "这些插件更新失败" : "These updates failed"),
                items: failures,
              }),
            }
            : null;
        // role="status" stays on a wrapper so a clickable sentence keeps its button semantics.
        const statusText = status
          ? h("span", { role: "status" },
            reopen
              ? h("button", {
                type: "button",
                className: "dpu-status dpu-statusMore",
                ...(tone ? { "data-tone": tone } : {}),
                ...reopen,
              }, status)
              : h("span", { className: "dpu-status", ...(tone ? { "data-tone": tone } : {}) }, status))
          : null;
        const controls = createPortal(h("div", { className: "dpu-head" },
          statusText,
          available.length > 1 && h(Button, {
            variant: "outline",
            size: "sm",
            disabled: locked,
            onClick: () => {
              setDialogOpen(true);
              setRun({ phase: "confirm", items: available.map(({ pkg, target }) => ({ pkg, target })) });
            },
            children: zh ? `全部更新 (${available.length})` : `Update all (${available.length})`,
          }),
          h(Button, {
            variant: "outline",
            size: "sm",
            disabled: !!(checking || running || managing),
            "aria-busy": !!checking,
            icon: checking ? h(StateDot, { state: "ongoing", size: 13 }) : h(IconRefreshOutlineRegular, { size: 13 }),
            onClick: checkAll,
            children: checking
              ? `${t("versionsChecking")} ${checking.done}/${checking.total}`
              : (zh ? "检查 GitHub 更新" : "Check GitHub updates"),
          })), heading, "controls");

        // The list rows are read back from the DOM, so each row's controls are portaled into its own action area.
        const actions = rows.map((container) => {
          const name = container.closest(PACKAGE)?.getAttribute("data-plugin-package");
          const pkg = byName.get(name);
          if (!pkg) return null;
          const result = resultOf(pkg);
          const item = run?.items.find((entry) => entry.pkg.name === name);
          if (!item && !result?.target && !result?.error) return null;
          const pending = item?.state === "pending" || item?.state === "running";
          const failed = item?.state === "failed";
          const target = result?.target;
          let content = null;
          if (failed) {
            content = h("span", { className: "dpu-fail" },
              h(StateDot, { state: "error", size: 12 }), zh ? "更新失败" : "Update failed");
          } else if (pending) {
            content = h("span", { className: "dpu-rowLabel" },
              h(StateDot, { state: "ongoing", size: 12 }), " ", zh ? "更新中" : "Updating");
          } else if (result?.error) {
            const message = result.error;
            content = h("button", {
              type: "button",
              className: "dpu-fail",
              title: message,
              onClick: () => setProblems({ title: zh ? "检查失败" : "Check failed", items: [{ name, message }] }),
            }, h(StateDot, { state: "error", size: 12 }), zh ? "检查失败" : "Check failed");
          } else if (target) {
            content = h("span", { className: "dpu-target" },
              h("span", { className: "dpu-badge" }, target.version),
              h(Button, {
                variant: "ghost",
                size: "sm",
                "aria-label": t("updateLabel", { name }),
                title: t("updateLabel", { name }),
                disabled: locked,
                onClick: () => {
                  setDialogOpen(true);
                  setRun({ phase: "confirm", items: [{ pkg, target }] });
                },
                children: t("update"),
              }));
          } else if (item) {
            content = h("span", { className: "dpu-rowLabel" }, zh ? "已是最新" : "Up to date");
          }
          if (!content) return null;
          return createPortal(h("div", { className: "dpu-row" }, content), container, name);
        });

        // One dialog carries the confirmation, the live per-package progress, and the outcome, so a batch
        // update never closes and reopens a modal between steps.
        const dialog = run && dialogOpen && h(Modal, {
          key: "update-run",
          open: true,
          onClose: () => {
            // A running batch keeps going with the dialog closed; its sentence in the toolbar reopens it.
            setDialogOpen(false);
            if (!running) setRun(null);
          },
          title: run.items.length === 1
            ? t("updateTitle", { name: run.items[0].pkg.name })
            : (zh ? `全部更新 (${run.items.length})` : `Update all (${run.items.length})`),
          closeLabel: t("close"),
          footer: run.phase === "confirm"
            ? [
              h(Button, {
                key: "cancel",
                variant: "outline",
                onClick: () => {
                  setDialogOpen(false);
                  setRun(null);
                },
              }, t("cancel")),
              h(Button, {
                key: "update",
                variant: "primary",
                disabled: managing,
                onClick: () => startUpdates(run.items),
              }, t("update")),
            ]
            : running
              ? [h("span", { key: "progress", className: "dpu-rowLabel" }, status)]
              : [h(Button, {
                key: "done",
                variant: "primary",
                onClick: () => {
                  setDialogOpen(false);
                  setRun(null);
                },
              }, zh ? "完成" : "Done")],
        }, h("ul", { className: "dpu-list" },
          run.items.map(({ pkg, target, state, error }) => h("li", { key: pkg.name, className: "dpu-item" },
            run.phase === "confirm" ? null : h(Glyph, { state }),
            h("div", { className: "dpu-main" },
              h("span", { className: "dpu-name" }, pkg.name),
              h("span", { className: "dpu-detail", ...(error ? { "data-tone": "error" } : {}) },
                error || `${pkg.version} → ${target.version}${target.repository ? ` · ${target.repository}` : ""}`,
                running && state === "running" ? (zh ? " · 正在更新" : " · updating") : ""))))));

        // Aggregated failures open on demand from the toolbar sentence or the row, never in the way of the list.
        const problemDialog = problems && h(Modal, {
          key: "problems",
          open: true,
          onClose: () => setProblems(null),
          title: problems.title,
          closeLabel: t("close"),
          footer: [h(Button, { key: "close", variant: "primary", onClick: () => setProblems(null) }, t("close"))],
        }, h("ul", { className: "dpu-list" },
          problems.items.map(({ name, message }) => h("li", { key: name, className: "dpu-item" },
            h("span", { className: "dpu-glyph", "data-tone": "error" }, h(StateDot, { state: "error", size: 13 })),
            h("div", { className: "dpu-main" },
              h("span", { className: "dpu-name" }, name),
              h("span", { className: "dpu-detail", "data-tone": "error" }, message))))));

        return [controls, ...actions, dialog, problemDialog];
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

