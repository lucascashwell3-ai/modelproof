/* Retired board engine layer (archived verbatim from board.html).
   The board called assets/decide.mjs (now archive/engine/assets/decide.mjs) to rank models per task
   and fill suggested swaps, the fit count, the starter board and the personal task table. The board
   now shows sourced facts only and exports an instruction package via assets/instructions.mjs.
   These fragments ran inside board.html's IIFE and are not runnable on their own. */

/* ---- import ---- */
/* The page loads the site's own decision engine — the same assets/decide.mjs lab.html calls —
   so every automatic pick on this board comes from the shipped rule engine, not a second
   opinion written here. A module script is deferred, so the DOM below is already parsed. */
import { decide } from "./assets/decide.mjs";

/* ---- safeVerdict: catalog verdict text in the model panes ---- */
  /* Item 12: a reason must never hand back a model the user excluded. Catalog verdicts sometimes
     name another model by name, so a verdict that points at an excluded model is not repeated. */
  function excludedMentionedIn(text){
    var t = String(text||"").toLowerCase();
    for (var i=0;i<state.neverSuggest.length;i++){
      var m = modelById(state.neverSuggest[i]);
      if (!m) continue;
      var names = [m.name.toLowerCase(), shortModelName(m).toLowerCase()];
      for (var j=0;j<names.length;j++){ if (names[j].length > 2 && t.indexOf(names[j]) !== -1) return m; }
    }
    return null;
  }
  function safeVerdict(m){
    if (!m) return "";
    var hit = excludedMentionedIn(m.verdict);
    if (!hit) return m.verdict;
    return "Our entry for this model points at " + shortModelName(hit) + ", which is on your never-suggest list, so we don't repeat that here.";
  }

/* ---- the engine layer ---- */
  /* ============================================================ the decision engine ============================================================
     Every automatic pick on this board — the suggested swap, the fit count, the starter board,
     the personal role picks and the personal task table — is `decide()` from the site's own
     assets/decide.mjs. The board ranks nothing itself.

     VOCABULARY. A block's `task` is already one of data/tasks.json's ids, so it needs no
     translation. The board also carries an older, coarser "category" vocabulary (coding /
     agentic / cheap-bulk / research / speed / vision / long-context) that the Role blocks and
     the personal task table still speak; CATEGORY_TASK below is the ONE place it maps onto an
     engine task id, and nothing else translates between the two. */
  var CATEGORY_TASK = {
    coding: "coding", agentic: "agents", "cheap-bulk": "bulk", research: "research",
    speed: "chat", vision: "vision", "long-context": "research"
  };
  var ENGINE_TASK_IDS = ["coding","agents","bulk","writing","research","extraction","chat","vision","frontend","exec-summaries"];
  function engineTaskId(v){
    if (!v) return null;
    if (ENGINE_TASK_IDS.indexOf(v) !== -1) return v;              // already a task id
    return CATEGORY_TASK[v] || null;                               // a board category
  }

  /* `have` — which labs this block can actually reach. A plan on the block reaches its own
     lab; a harness plan (Cursor, GitHub Copilot) reaches every lab, which the engine spells
     'any'. No plan at all means the board's own lab list decides, and a lab the engine has no
     key for is still reachable through OpenRouter, so that is added rather than dropped. */
  var ENGINE_VENDOR_KEY = { Anthropic: "anthropic", OpenAI: "openai", Google: "google", xAI: "xai" };
  function engineHaveFor(planNames){
    var list = (planNames || []).filter(Boolean);
    if (list.length){
      var reach = reachableVendorsFor(list);
      if (!reach) return ["any"];                                  // a harness plan reaches everything
      var keys = reach.map(function(v){ return ENGINE_VENDOR_KEY[v]; }).filter(Boolean);
      if (reach.some(function(v){ return !ENGINE_VENDOR_KEY[v]; })) keys.push("openrouter");
      return keys.length ? keys : ["any"];
    }
    return engineHaveForLabs((state && state.startFilters && state.startFilters.labs) || []);
  }
  function engineHaveForLabs(labs){
    var list = (labs || []).filter(Boolean);
    if (!list.length) return ["any"];
    var keys = list.map(function(v){ return ENGINE_VENDOR_KEY[v]; }).filter(Boolean);
    if (list.some(function(v){ return !ENGINE_VENDOR_KEY[v]; })) keys.push("openrouter");
    return keys.length ? keys : ["any"];
  }
  function boardStance(){
    if (mode === "personal") return state.personal.me.optimizeFor || "balanced";
    return (state.startFilters && state.startFilters.stance) || "balanced";
  }
  /* Volume: the block's own usage level, in the engine's own words. An automated routine or a
     hand-edited budget is a custom monthly volume, which the engine takes as numbers. */
  function engineVolumeFor(b){
    if (!b) return "typical";
    var lv = levelOf(b);
    if (lv === "light" || lv === "typical" || lv === "heavy"){
      if (b.tokensEdited){ var bd = budgetOf(b); return { tokens_in_month: bd.in, tokens_out_month: bd.out }; }
      return lv;
    }
    var bud = budgetOf(b);
    return { tokens_in_month: bud.in, tokens_out_month: bud.out };
  }

  /* One call, cached on its own inputs (including the board's rule layer, so a change to the
     data rule or the never-suggest list makes a new key rather than a stale answer). render()
     asks for a shortlist once per block per paint; without this the engine would re-index the
     whole catalog every time. */
  var engineCache = {};
  function engineShortlist(taskId, opts){ return engineShortlistInfo(taskId, opts).list; }
  /* `raw` is what decide() returned; `list` is what survives the board's own rule layer. Keeping
     both lets an empty result say WHICH of the two emptied it, instead of one message that is
     true in one case and misleading in the other. */
  function engineShortlistInfo(taskId, opts){
    opts = opts || {};
    var task = engineTaskId(taskId);
    if (!task || !DATA) return { raw: [], list: [] };
    var input = {
      tasks: [task],
      have: opts.have || ["any"],
      stance: opts.stance || boardStance(),
      volume: opts.volume || "typical",
      dataRule: { noChinaHosted: currentDataRule() === "no-china" }
    };
    var key = JSON.stringify(input) + "|" + currentDataRule() + "|" + state.neverSuggest.join(",");
    if (engineCache[key]) return engineCache[key];
    var out;
    try { out = decide(input, { models: DATA.models, plans: DATA.plans, presets: DATA.usage_presets, vendors: DATA.vendors }); }
    catch (err){ console.error("decide() failed for " + task, err); out = { tasks: {} }; }
    var raw = (out.tasks[task] || {}).shortlist || [];
    var list = raw.filter(function(it){
      // The engine ranks; the board's own rule layer still has the last word — a model the user
      // excluded, or one the board's enterprise-only rule flags, is never handed back as a pick,
      // and an unpriced model is never picked automatically because it cannot be costed.
      return allowedForAuto(it.id) && isPriced(modelById(it.id));
    });
    engineCache[key] = { raw: raw, list: list };
    return engineCache[key];
  }
  /* What to say when there is nothing to pick. Two different facts, two different sentences. */
  function emptyShortlistText(taskId, opts){
    return engineShortlistInfo(taskId, opts).raw.length
      ? RULED_OUT
      : NO_SHORTLIST;
  }
  function emptyShortlistTextForBlock(b){
    return emptyShortlistText(b && b.task, { have: engineHaveFor(planListOf(b)), volume: engineVolumeFor(b) });
  }
  /* The shortlist for one block, asked with that block's own plans, stance and volume. */
  function engineShortlistForBlock(b){
    return engineShortlist(b && b.task, { have: engineHaveFor(planListOf(b)), volume: engineVolumeFor(b) });
  }
  function engineTopForBlock(b){ var l = engineShortlistForBlock(b); return l.length ? l[0] : null; }
  function bestFitModelIdFor(b){ var t = engineTopForBlock(b); return t ? t.id : null; }

  function isBestFit(block){
    var top = bestFitModelIdFor(block);
    if (!top) return true;                                          // no shortlist for this task — nothing to be off
    return blockModel(block) === top;
  }

  /* Item 7: a reason is evidence, never an adjective. The sentence is the model's own catalog
     row (vendor, task, list price) plus — when the engine has it — one plain clause of standing:
     where this model sits among the catalog models that carry each kind of evidence for the task. */
  function ordinal(n){
    n = Math.round(n || 0);
    if (n <= 0) return String(n);
    var s = ["th","st","nd","rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function standingClause(item){
    var ev = (item && item.evidence) || {}, bits = [];
    if (ev.measured && ev.measured.present) bits.push(ordinal(ev.measured.position) + " on independent tests");
    if (ev.chosen) bits.push(ordinal(ev.chosen.position) + " by OpenRouter spend");
    if (ev.preferred) bits.push(ordinal(ev.preferred.position) + " by human votes");
    return bits.length ? bits.join(", ") + "." : "";
  }
  function priceClause(m){
    return isPriced(m)
      ? fmtPrice(m.price_input) + " in / " + fmtPrice(m.price_output) + " out per 1M."
      : "Price not listed.";
  }
  function engineReason(item, taskId){
    var m = modelById(item.id);
    if (!m) return "";
    var task = engineTaskId(taskId);
    var line = m.vendor + " lists " + shortModelName(m) + " for " + taskLabel(task).toLowerCase() + ". " + priceClause(m);
    var st = standingClause(item);
    return st ? (line + " " + st) : line;
  }
  var NO_SHORTLIST = "No shortlist for this task yet.";
  var RULED_OUT = "Every model on the shortlist for this task is ruled out by your own settings.";
  /* The same evidence sentence for a model the user chose themselves. When the engine's top
     three carry it we use its own row (standing and all); otherwise we state the catalog facts
     without inventing a standing it never returned. */
  function evidenceFor(modelId, taskId, list){
    var item = (list || []).find(function(it){ return it.id === modelId; });
    if (item) return engineReason(item, taskId);
    var m = modelById(modelId);
    if (!m) return "";
    return m.vendor + " lists " + shortModelName(m) + " for " + taskLabel(engineTaskId(taskId)).toLowerCase() + ". " + priceClause(m);
  }

  /* ---- Optimize-for tier: drives the personal task table + AGENTS.md, never a fixed guess ----
     cheapest = cheapest model ON THE USER'S PLAN (same vendor as their subscription) that lists
     the task in best_for; balanced = mid-priced model across the whole catalog; best = highest
     coding_score (ties broken by confidence) across the whole catalog. A tier with no qualifying
     model returns "not measured" rather than inventing a pick. */
  var OPTIMIZE_COPY = {
    cheapest: "default to the cheapest model on your plan that covers a task; if nothing on your plan is measured for it, that task shows as not measured rather than a guess.",
    balanced: "pick a mid-priced model per task, balancing quality and cost instead of chasing either extreme.",
    best: "use the strongest measured model per task regardless of price, since quality is the priority here."
  };
  /* The board's Role blocks are the routing: a task is served by the role whose kind covers its
     category. Role names are free text, so kinds come from the words people actually use. */
  var ROLE_KIND_RULES = [
    { kind: "coordinator", re: /coordinat|planner|plan\b|orchestrat|lead/i, cats: ["agentic"] },
    { kind: "bulk", re: /bulk|extract|classif|volume|batch|pipeline/i, cats: ["cheap-bulk"] },
    { kind: "research", re: /research|analy/i, cats: ["research"] },
    { kind: "design", re: /design|visual|\bui\b/i, cats: ["coding"] },
    { kind: "chat", re: /chat|triage|support|assistant/i, cats: ["speed"] },
    { kind: "long-haul code", re: /code|coding|engineer|\bdev\b|frontend|build/i, cats: ["coding"] }
  ];
  function roleKindRule(name){
    for (var i=0;i<ROLE_KIND_RULES.length;i++){ if (ROLE_KIND_RULES[i].re.test(String(name||""))) return ROLE_KIND_RULES[i]; }
    return null;
  }
  function roleKind(name){ var r = roleKindRule(name); return r ? r.kind : null; }
  function roleCovers(role, category){
    var r = roleKindRule(role.role);
    return !!(r && category && r.cats.indexOf(category) !== -1);
  }
  function roleForCategory(category){
    if (!state || !state.personal) return null;
    return state.personal.roles.find(function(r){ return r.model && roleCovers(r, category); }) || null;
  }
  function planVendorOf(planName){ var p = planByName(planName); return p ? p.vendor : null; }
  function tierEffort(tier){ return tier === "cheapest" ? "low" : tier === "balanced" ? "medium" : "max"; }
  function computePersonalTaskRow(def, tier, planName){
    var cat = def.category, label = def.label;
    var task = def.task || engineTaskId(cat);
    var plans = Array.isArray(planName) ? planName : (planName ? [planName] : []);
    if (!task) return { label: label, model: null, effort: null, roleName: null, reason: "This task isn\u2019t one of our tasks yet, so there is nothing to pick from.", notMeasured: true };
    // A role on the board wins: its attached model IS the answer, at the effort set on the role
    // (or the stance's effort where the role sets none).
    var role = cat ? roleForCategory(cat) : null;
    var prefix = "No role set for this yet. ";
    if (role && isExcluded(role.model)){
      prefix = "Your \u201c" + role.role + "\u201d role has a never-suggest model attached, so this is our pick instead. ";
      role = null;
    }
    var list = engineShortlist(task, { have: engineHaveFor(plans), stance: tier });
    if (role){
      var reff = role.effort || tierEffort(tier);
      var breach = dataRuleBreach(role.model);
      return { label: label, model: role.model, effort: reff, roleName: role.role, notMeasured: false,
        reason: "Your \u201c" + role.role + "\u201d role \u2014 the model attached to it on the board, at " + reff + " effort" +
                (role.effort ? " set on that role." : " for the " + tier + " stance.") +
                " " + evidenceFor(role.model, task, list) +
                (breach ? " Breaks your data rule: " + breach + "." : "") };
    }
    if (!list.length){
      return { label: label, model: null, effort: null, roleName: null, notMeasured: true,
               reason: prefix + emptyShortlistText(task, { have: engineHaveFor(plans), stance: tier }) };
    }
    return { label: label, model: list[0].id, effort: tierEffort(tier), roleName: null, notMeasured: false,
             reason: prefix + engineReason(list[0], task) };
  }


/* ---- suggested swaps ---- */
  /* ============================================================ suggested models ============================================================
     One rule, no curated list: a block's suggestion is the engine's first shortlist entry for
     that block's task, offered when it differs from the block's own model AND either lowers the
     cost or fixes a data-rule breach. The reason is the engine's own evidence. */
  function engineSwapFor(b){
    if (!b || !blockModel(b)) return null;
    var top = engineTopForBlock(b);
    if (!top || top.id === blockModel(b)) return null;
    var breach = blockBreach(b);
    var before = costOfBlock(b);
    var after = costOfBlock(b.type === "routine"
      ? variantOf(b, { seats: 0, plans: [], models: [top.id] })
      : variantOf(b, { models: [top.id] }));
    var save = before - after;
    if (!breach && save <= 0.5) return null;
    return { item: top, toModel: top.id, save: save, breach: breach,
             reason: (breach ? "Breaks your data rule (" + breach + "). " : "") + engineReason(top, b.task) };
  }

  function saveLabel(save){
    if (save > 0.5) return "saves " + fmtUsd(save) + "/mo";
    if (save < -0.5) return "costs " + fmtUsd(-save) + " more/mo";
    return "same cost";
  }
  /* A rule breach is the loudest problem on a board, so those rows come first even when the
     replacement costs more (the row says so rather than pretending it saves). */
  function computeSuggestions(){
    var rule = [], cheaper = [];
    state.org.blocks.forEach(function(b){
      var s = engineSwapFor(b);
      if (!s) return;
      var row = { kind: s.breach ? "rule" : "fit", blockId: b.id, who: b.who, fromModel: blockModel(b),
                  toModel: s.toModel, toPlan: null, save: s.save, reason: s.reason };
      (s.breach ? rule : cheaper).push(row);
    });
    return rule.concat(cheaper).slice(0, 4);
  }

/* ---- per-block pick pane ---- */
  function pickBlockHtml(b){
    var mid = blockModel(b);
    var m = modelById(mid);
    var html = "";
    if (mid && b.versionUnstated){
      html += '<div class="bp-empty-note">Version not stated — matched to the newest, ' + escapeHtml(shortModelName(m)) + '.</div>';
    }
    if (!mid && b.modelRaw){
      html += '<div class="bp-pick-line"><b>' + escapeHtml(b.modelRaw) + '</b> is not in our data yet.</div>' +
        '<div class="bp-pick-reason">Pick a real model above to see cost and a recommendation.</div>';
      return html;
    }
    if (!mid){
      html += '<div class="bp-pick-line">No model picked yet.</div>' +
        '<div class="bp-pick-reason">Pick one above to see cost and a recommendation.</div>';
      return html;
    }
    // Item 1: the data rule outranks cost. A flagged block gets the engine's first allowed pick,
    // and the button says plainly whether that costs more.
    var breach = blockBreach(b);
    html += bpFlagHtml(breach);
    var swap = engineSwapFor(b);
    if (swap){
      var to = modelById(swap.toModel);
      html += '<div class="bp-pick-line">You chose <b>' + escapeHtml(shortModelName(m)) + '</b>. We\'d pick <b>' + escapeHtml(shortModelName(to)) + '</b>' + (breach ? ', which clears your rule' : '') + '.</div>' +
        '<div class="bp-pick-reason">' + escapeHtml(swap.reason) + '</div>' +
        '<button class="bp-apply" data-pd-model="' + escapeAttr(swap.toModel) + '" data-pd-plan="">' + icon("apply", 13) + 'Apply \u2014 ' + escapeHtml(saveLabel(swap.save)) + '</button>';
      return html;
    }
    if (breach){
      html += '<div class="bp-pick-line">You chose <b>' + escapeHtml(shortModelName(m)) + '</b>. Nothing in our data is both allowed under your rule and on the shortlist for ' +
        escapeHtml(taskLabel(engineTaskId(b.task)).toLowerCase()) + ', so we\'re not proposing a swap.</div>';
      return html;
    }
    html += bestFitVerdictHtml(b, m);
    return html;
  }
  /* No swap to offer. The reason line stays evidence: the engine's own row for the model this
     block is already on, or a plain sentence when the engine has no shortlist for the task. */
  function bestFitVerdictHtml(b, m){
    var list = engineShortlistForBlock(b);
    var mine = list.find(function(it){ return it.id === blockModel(b); }) || null;
    var line = isExcluded(blockModel(b))
      ? 'You chose <b>' + escapeHtml(shortModelName(m)) + '</b>, which is on your never-suggest list. It stays because you picked it.'
      : (mine
          ? 'You chose <b>' + escapeHtml(shortModelName(m)) + '</b>, which is our first pick for this task.'
          : 'You chose <b>' + escapeHtml(shortModelName(m)) + '</b>. Nothing on the shortlist lowers the cost, so it stays.');
    var reason = mine ? engineReason(mine, b.task) : (list.length ? engineReason(list[0], b.task) : emptyShortlistTextForBlock(b));
    return '<div class="bp-pick-line">' + line + '</div>' +
      '<div class="bp-pick-reason">' + escapeHtml(reason) + '</div>';
  }


/* ---- auto roles + starter picks ---- */
  /* Starter roles are picked for you, not chosen by you: they carry auto:true until a model is
     set by hand, and only those follow Cheapest / Balanced / Best. Bulk always takes the cheap
     end and the coordinator the strong end; the tier moves the rest. The other roles avoid the
     coordinator's model when the plan reaches another one, so the coordinator never hands work
     to itself. They may share with each other: forcing every role apart pushed "cheapest"
     research onto the most expensive model once the small pool ran out. */
  var ROLE_STANCE = {
    "Bulk": function(){ return "cheapest"; },
    "Coordinator": function(t){ return t === "cheapest" ? "balanced" : "best"; }
  };
  function autoRoleModel(task, stance, planNames, used){
    var list = engineShortlist(task, { have: engineHaveFor(planNames), stance: stance });
    if (!list.length) return null;
    var fresh = list.filter(function(it){ return used.indexOf(it.id) === -1; });
    return (fresh.length ? fresh[0] : list[0]).id;
  }
  function assignAutoRoles(roles, tier, planNames){
    function pick(r, avoid){
      if (!r.auto || !r.seedTask) return;
      var st = ROLE_STANCE[r.role] ? ROLE_STANCE[r.role](tier) : tier;
      r.model = autoRoleModel(r.seedTask, st, planNames, avoid);
    }
    var coord = roles.find(function(r){ return roleKind(r.role) === "coordinator"; });
    if (coord) pick(coord, []);
    // Balanced and Best spread the work: a role steps past the coordinator's model to the next
    // engine pick, so the coordinator has somewhere to hand off. Cheapest never does — the
    // cheapest model that clears the bar is the answer even when the coordinator already runs it
    // (AGENTS.md then says the coordinator does that work itself).
    var avoid = (tier !== "cheapest" && coord && coord.model) ? [coord.model] : [];
    roles.forEach(function(r){ if (r !== coord) pick(r, avoid); });
  }
  // The tier control's job on a personal board: re-pick the auto roles, keep "Your models" in
  // step (models added only for a role leave when no role uses them).
  function repickAutoRoles(){
    var roles = state.personal.roles, me = state.personal.me;
    if (!roles.some(function(r){ return r.auto; })) return;
    assignAutoRoles(roles, me.optimizeFor, planListOf(me));
    var need = roles.map(function(r){ return r.model; }).filter(Boolean);
    state.personal.owned = state.personal.owned.filter(function(o){ return !o.forRole || need.indexOf(o.model) !== -1; });
    need.forEach(function(mid){
      if (state.personal.owned.some(function(o){ return o.model === mid; }) || state.personal.owned.length >= 8) return;
      var id = uid(); justCreated[id] = true;
      state.personal.owned.push({ id: id, model: mid, x: 300, y: 200, forRole: true });
    });
    me.uses = state.personal.owned.map(function(o){ return o.model; });
  }
  /* The starter board uses the same shortlist every other pick on this board uses: the engine's
     first entry for the task, asked with the labs the user says they pay for and the stance they
     chose. An empty shortlist is left empty rather than filled with a guess. */
  function starterModelFor(taskId, stance, labs){
    var list = engineShortlist(taskId, { have: engineHaveForLabs(labs), stance: stance });
    return list.length ? list[0].id : null;
  }

/* ---- debug hook ---- */
  // The engine, read-only: what decide() hands back for a task or a block, after the board's
  // own rule layer. No write path, no effect on what is on screen.
  // The plan table, read-only: what a plan row reaches and whether its seat pays for tokens.
  window.__mpPlans = {
    reach: planReach, reachOf: planReachOf, reachVendors: reachableVendorsFor,
    covers: planCoversTokens, price: planPrice, priceUnknown: planPriceUnknown,
    perTokenPlatforms: perTokenPlatforms, table: PLAN_REACH
  };
  window.__mpEngine = {
    shortlist: function(taskId, opts){ return engineShortlist(taskId, opts); },
    forBlock: function(blockId){
      var b = state.org.blocks.find(function(x){ return x.id === blockId; });
      return b ? engineShortlistForBlock(b) : [];
    },
    swapFor: function(blockId){
      var b = state.org.blocks.find(function(x){ return x.id === blockId; });
      return b ? engineSwapFor(b) : null;
    },
    info: function(taskId, opts){ return engineShortlistInfo(taskId, opts); },
    emptyText: function(taskId, opts){ return emptyShortlistText(taskId, opts); },
    taskId: engineTaskId, have: engineHaveFor, haveForLabs: engineHaveForLabs, stance: boardStance,
    noShortlistText: NO_SHORTLIST, ruledOutText: RULED_OUT
  };
