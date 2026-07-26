/**
 * 5kable — Content Script
 * Injects the floating analysis panel into GeoGuessr
 */

const PLATFORM_API = 'https://api.5kable.net';
const FREE_DAILY_LIMIT = 10;
// Google Maps Embed API key — used only to embed LIVE Street View panoramas
// (via pano_id) directly from Google, never to store/download imagery
// ourselves. This key must have the Maps Embed API enabled and its HTTP
// referrer restrictions set to allow https://www.geoguessr.com/*, since
// requests are made from within the GeoGuessr page itself.
const STREETVIEW_EMBED_KEY = 'AIzaSyAV0LW7v8Ych7rMQz560rm7SEj31juUV7I';

// ── State ──────────────────────────────────────────────────
let isAnalysing = false;
let wasInGame = false;
let userExpandedThisGame = false;
let roundActive = false;
let lastImageB64 = null;
let gaxToken = null;
let gaxUser = null;
let gaxTier = 'free';
let lastAnalysisText = '';
let lastAnalysisRound = 0; // which round lastAnalysisText's content actually belongs to
function buildTeachingContextText(loc){
  if (!loc) return '';
  return [
    `CORRECT LOCATION: ${loc.correctName}`,
    `DEAD GIVEAWAY: ${loc.keyClue}`,
    loc.bullets?.length ? `KEY VISUAL CLUES:\n${loc.bullets.slice(0,3).map((b,i) => `${i+1}. ${b}`).join('\n')}` : '',
    loc.guessLocationName ? `THE PLAYER GUESSED: ${loc.guessLocationName} — THIS WAS WRONG.` : '',
    loc.distanceKm ? `DISTANCE OFF: ${loc.distanceKm}km` : '',
  ].filter(Boolean).join('\n\n');
}
// Cheap, no-AI-call version of the same context — built from just the
// reverse-geocoded location names and distance, straight from the round
// result. Runs on every round regardless of the Training Guides toggle
// or whether the guess was right or wrong, so "Ask GeoX" always has at
// least the basics to work with. The richer, AI-generated version above
// (with the actual Key Clue) overwrites this afterwards whenever the
// full teaching flow actually runs.
function buildLightContextText(correctGeo, guessGeo, dist, isCorrect){
  const correctName = [correctGeo?.state, correctGeo?.country].filter(Boolean).join(', ');
  const guessName = [guessGeo?.state, guessGeo?.country].filter(Boolean).join(', ');
  if (!correctName) return '';
  return [
    `CORRECT LOCATION: ${correctName}`,
    guessName ? `THE PLAYER GUESSED: ${guessName} — THIS WAS ${isCorrect ? 'CORRECT' : 'WRONG'}.` : '',
    (dist || dist === 0) ? `DISTANCE OFF: ${dist}km` : '',
  ].filter(Boolean).join('\n\n');
}
let _gax_coords = null;
let _gax_prev_coords = null;
let _gax_f7_image = null;
let _gax_f7_coords = null;
let _gax_scene_image = null;
let pendingTeach = null;
let teachRound = 0;
let _gax_guess_lat = null;
let _gax_guess_lng = null;
let lessonCount = 0;
let gaxDisabled = false;
let gaxAutoGuide = true;

let lastLesson = null;

// ── Init ───────────────────────────────────────────────────
async function init() {
  // If the user disabled 5kable, skip setup entirely and just show
  // a tiny "re-enable" nub — no panel, no hotkeys, no fetch intercept.
  const disabledData = await chrome.storage.local.get(['gax_script_disabled']);
  gaxDisabled = !!disabledData.gax_script_disabled;
  if (gaxDisabled) {
    injectDisabledNub();
    return;
  }

  // Load auth from storage
  const data = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
  gaxToken = data.gax_token || null;
  gaxUser  = data.gax_user  || null;

  const autoGuideData = await chrome.storage.local.get(['gax_auto_guide']);
  // Default to true (on) for anyone who's never touched this setting.
  gaxAutoGuide = autoGuideData.gax_auto_guide !== false;
  gaxTier  = data.gax_tier  || 'free';

  // Restore the last teaching lesson's context, if any. GeoGuessr often
  // does a full page navigation between games/maps (not just a round
  // change), which re-injects this content script from scratch and
  // wipes all in-memory JS state — without this, "Ask GeoX" would lose
  // all knowledge of what was just taught the moment the player started
  // a new game, even seconds later.
  const lastAnalysisData = await chrome.storage.local.get(['gax_last_analysis']);
  lastAnalysisText = lastAnalysisData.gax_last_analysis || '';
  // -1 is a sentinel that can never match a real round number (rounds
  // start at 1), so restored context always gets re-validated against
  // whatever round is actually being played before it's trusted.
  lastAnalysisRound = -1;

  // Verify token is still valid
  if (gaxToken) {
    try {
      const verify = await apiCall('/auth/verify', { token: gaxToken });
      if (verify.valid && verify.user) {
        gaxUser = verify.user;
        gaxTier = verify.user.tier;
        chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: gaxToken, user: gaxUser, tier: gaxTier });
      } else {
        gaxToken = null; gaxUser = null; gaxTier = 'free';
      }
    } catch(e) {}
  }

  injectPanel();
  updateChatModeBadge();
  setupFetchIntercept();
  setupRoundDetection();
  setupHotkeys();

  // Keep the Analyse button's enabled/disabled state in sync with whether
  // the user is actually in a round — checked once now, then polled since
  // navigating between the home page and a round doesn't reload the page.
  updateAnalyseAvailability();
  setInterval(updateAnalyseAvailability, 1000);

  // Check for extension updates
  checkForUpdate();

  if (!gaxToken) {
    setStatus('Sign in via extension icon ↗');
  } else {
    updateHeader();
    const analyseBtn = document.getElementById('gax-analyse-btn');
    if (gaxTier !== 'pro' && analyseBtn) {
      analyseBtn.textContent = '🔒 ANALYSE — Pro Only';
      analyseBtn.style.background = 'linear-gradient(135deg, #2a2a3e, #1e1e2e)';
      analyseBtn.style.color = '#8888aa';
      analyseBtn.style.border = '1px solid #7c3aed';
    }
    setStatus(`Ready — ${gaxTier === 'pro' ? '⭐ Pro' : 'Free'} · ${gaxTier === 'pro' ? 'Analyse or ' : ''}F7`);
    loadUsage();
  }

  // GeoGuessr listens for single-key hotkeys (E = emote wheel, R = revert
  // view, F = fullscreen, N = face north, etc.) on the page itself. Since
  // our panel's inputs (country search, chat boxes) live in the same page,
  // GeoGuessr's own listener still sees every keystroke typed into them
  // and fires its hotkey too — e.g. typing "narrow" into the country box
  // triggers N (north) and R (revert) along the way. Capture-phase here
  // means this runs before GeoGuessr's own (bubble-phase) listener,
  // regardless of registration order, so stopping propagation here keeps
  // it from ever seeing the keystroke. stopPropagation only (never
  // preventDefault) — the character still needs to actually type into our
  // own input normally. F7/F8 stay excluded since those are our own
  // global hotkeys and should keep working everywhere, panel-focused or not.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F7' || e.key === 'F8') return;
    const panel = document.getElementById('gax-panel');
    if (panel && e.target && e.target.closest && e.target.closest('#gax-panel')) {
      e.stopPropagation();
    }
  }, { capture: true });

  // Ctrl+Arrow keys to move panel vertically (GeoGuessr blocks mouse vertical drag)
  document.addEventListener('keydown', (e) => {
    if (gaxDisabled) return;
    if (!e.ctrlKey) return;
    const panel = document.getElementById('gax-panel');
    if (!panel) return;
    const step = 30;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      panel.style.top = Math.max(0, panel.offsetTop - step) + 'px';
      panel.style.bottom = 'auto';
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      panel.style.top = Math.min(window.innerHeight - panel.offsetHeight, panel.offsetTop + step) + 'px';
      panel.style.bottom = 'auto';
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      panel.style.left = Math.max(0, panel.offsetLeft - step) + 'px';
      panel.style.right = 'auto';
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      panel.style.left = Math.min(window.innerWidth - panel.offsetWidth, panel.offsetLeft + step) + 'px';
      panel.style.right = 'auto';
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.gax_token || changes.gax_user || changes.gax_tier) {
      chrome.runtime.sendMessage({ type: 'GET_TOKEN' }, (d) => {
        gaxToken = d.gax_token || null;
        gaxUser  = d.gax_user  || null;
        gaxTier  = d.gax_tier  || 'free';
        updateHeader();
        const analyseBtn = document.getElementById('gax-analyse-btn');
        if (analyseBtn) {
          if (gaxTier === 'pro') {
            analyseBtn.textContent = '🔍 ANALYSE';
            analyseBtn.style.background = 'linear-gradient(135deg, #00c9a7, #00a87d)';
            analyseBtn.style.color = '#000';
            analyseBtn.style.border = 'none';
          } else {
            analyseBtn.textContent = '🔒 ANALYSE — Pro Only';
            analyseBtn.style.background = 'linear-gradient(135deg, #2a2a3e, #1e1e2e)';
            analyseBtn.style.color = '#8888aa';
            analyseBtn.style.border = '1px solid #7c3aed';
          }
        }
        if (gaxToken) {
          setStatus(`Ready — ${gaxTier === 'pro' ? '⭐ Pro' : 'Free'} · ${gaxTier === 'pro' ? 'Analyse or ' : ''}F7`);
          loadUsage();
        } else {
          setStatus('Sign in via extension icon ↗');
        }
      });
    }
  });
}

// ── Panel HTML ─────────────────────────────────────────────
function injectPanel() {
  if (document.getElementById('gax-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'gax-panel';
  panel.innerHTML = `
    <div id="gax-header">
      <img id="gax-title-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="5kable">
      <span id="gax-tier-badge">Free</span>
      <button id="gax-disable-btn" title="Hide 5kable">⏻</button>
    </div>
    <div id="gax-body">
      <div id="gax-status">Ready</div>
      <div id="gax-result"></div>

      <div id="gax-country-wrap">
        <div id="gax-country-btn">🌍 World mode (auto-detect)</div>
        <div id="gax-country-list" style="display:none">
          <input id="gax-country-filter" type="text" placeholder="Search countries..." style="width:100%;box-sizing:border-box;background:#1a1a2e;border:1px solid #2a2a3e;color:#e0e0f0;padding:6px 8px;border-radius:6px;font-size:12px;margin-bottom:4px;outline:none;">
          <div class="gax-country-opt" data-val="">🌍 World mode</div>
          <div class="gax-country-opt" data-val="Botswana">Botswana</div>
          <div class="gax-country-opt" data-val="Eswatini">Eswatini</div>
          <div class="gax-country-opt" data-val="Ghana">Ghana</div>
          <div class="gax-country-opt" data-val="Kenya">Kenya</div>
          <div class="gax-country-opt" data-val="Lesotho">Lesotho</div>
          <div class="gax-country-opt" data-val="Madagascar">Madagascar</div>
          <div class="gax-country-opt" data-val="Namibia">Namibia</div>
          <div class="gax-country-opt" data-val="Nigeria">Nigeria</div>
          <div class="gax-country-opt" data-val="Rwanda">Rwanda</div>
          <div class="gax-country-opt" data-val="São Tomé and Príncipe">São Tomé and Príncipe</div>
          <div class="gax-country-opt" data-val="Senegal">Senegal</div>
          <div class="gax-country-opt" data-val="South Africa">South Africa</div>
          <div class="gax-country-opt" data-val="Tunisia">Tunisia</div>
          <div class="gax-country-opt" data-val="Uganda">Uganda</div>
          <div class="gax-country-opt" data-val="Bangladesh">Bangladesh</div>
          <div class="gax-country-opt" data-val="Bhutan">Bhutan</div>
          <div class="gax-country-opt" data-val="Cambodia">Cambodia</div>
          <div class="gax-country-opt" data-val="Christmas Island">Christmas Island</div>
          <div class="gax-country-opt" data-val="Cyprus">Cyprus</div>
          <div class="gax-country-opt" data-val="Georgia">Georgia</div>
          <div class="gax-country-opt" data-val="Hong Kong">Hong Kong</div>
          <div class="gax-country-opt" data-val="India">India</div>
          <div class="gax-country-opt" data-val="Indonesia">Indonesia</div>
          <div class="gax-country-opt" data-val="Israel">Israel</div>
          <div class="gax-country-opt" data-val="Japan">Japan</div>
          <div class="gax-country-opt" data-val="Jordan">Jordan</div>
          <div class="gax-country-opt" data-val="Kazakhstan">Kazakhstan</div>
          <div class="gax-country-opt" data-val="Kyrgyzstan">Kyrgyzstan</div>
          <div class="gax-country-opt" data-val="Laos">Laos</div>
          <div class="gax-country-opt" data-val="Lebanon">Lebanon</div>
          <div class="gax-country-opt" data-val="Malaysia">Malaysia</div>
          <div class="gax-country-opt" data-val="Mongolia">Mongolia</div>
          <div class="gax-country-opt" data-val="Nepal">Nepal</div>
          <div class="gax-country-opt" data-val="Oman">Oman</div>
          <div class="gax-country-opt" data-val="Philippines">Philippines</div>
          <div class="gax-country-opt" data-val="Qatar">Qatar</div>
          <div class="gax-country-opt" data-val="Russia">Russia</div>
          <div class="gax-country-opt" data-val="Singapore">Singapore</div>
          <div class="gax-country-opt" data-val="South Korea">South Korea</div>
          <div class="gax-country-opt" data-val="Sri Lanka">Sri Lanka</div>
          <div class="gax-country-opt" data-val="Taiwan">Taiwan</div>
          <div class="gax-country-opt" data-val="Thailand">Thailand</div>
          <div class="gax-country-opt" data-val="United Arab Emirates">United Arab Emirates</div>
          <div class="gax-country-opt" data-val="Vietnam">Vietnam</div>
          <div class="gax-country-opt" data-val="Albania">Albania</div>
          <div class="gax-country-opt" data-val="Andorra">Andorra</div>
          <div class="gax-country-opt" data-val="Austria">Austria</div>
          <div class="gax-country-opt" data-val="Belgium">Belgium</div>
          <div class="gax-country-opt" data-val="Bosnia and Herzegovina">Bosnia and Herzegovina</div>
          <div class="gax-country-opt" data-val="Bulgaria">Bulgaria</div>
          <div class="gax-country-opt" data-val="Croatia">Croatia</div>
          <div class="gax-country-opt" data-val="Czech Republic">Czech Republic</div>
          <div class="gax-country-opt" data-val="Denmark">Denmark</div>
          <div class="gax-country-opt" data-val="Estonia">Estonia</div>
          <div class="gax-country-opt" data-val="Faroe Islands">Faroe Islands</div>
          <div class="gax-country-opt" data-val="Finland">Finland</div>
          <div class="gax-country-opt" data-val="France">France</div>
          <div class="gax-country-opt" data-val="Germany">Germany</div>
          <div class="gax-country-opt" data-val="Gibraltar">Gibraltar</div>
          <div class="gax-country-opt" data-val="Greece">Greece</div>
          <div class="gax-country-opt" data-val="Hungary">Hungary</div>
          <div class="gax-country-opt" data-val="Iceland">Iceland</div>
          <div class="gax-country-opt" data-val="Ireland">Ireland</div>
          <div class="gax-country-opt" data-val="Isle of Man">Isle of Man</div>
          <div class="gax-country-opt" data-val="Italy">Italy</div>
          <div class="gax-country-opt" data-val="Jersey">Jersey</div>
          <div class="gax-country-opt" data-val="Latvia">Latvia</div>
          <div class="gax-country-opt" data-val="Liechtenstein">Liechtenstein</div>
          <div class="gax-country-opt" data-val="Lithuania">Lithuania</div>
          <div class="gax-country-opt" data-val="Luxembourg">Luxembourg</div>
          <div class="gax-country-opt" data-val="Malta">Malta</div>
          <div class="gax-country-opt" data-val="Monaco">Monaco</div>
          <div class="gax-country-opt" data-val="Montenegro">Montenegro</div>
          <div class="gax-country-opt" data-val="Netherlands">Netherlands</div>
          <div class="gax-country-opt" data-val="North Macedonia">North Macedonia</div>
          <div class="gax-country-opt" data-val="Norway">Norway</div>
          <div class="gax-country-opt" data-val="Poland">Poland</div>
          <div class="gax-country-opt" data-val="Portugal">Portugal</div>
          <div class="gax-country-opt" data-val="Romania">Romania</div>
          <div class="gax-country-opt" data-val="San Marino">San Marino</div>
          <div class="gax-country-opt" data-val="Serbia">Serbia</div>
          <div class="gax-country-opt" data-val="Slovakia">Slovakia</div>
          <div class="gax-country-opt" data-val="Slovenia">Slovenia</div>
          <div class="gax-country-opt" data-val="Spain">Spain</div>
          <div class="gax-country-opt" data-val="Sweden">Sweden</div>
          <div class="gax-country-opt" data-val="Switzerland">Switzerland</div>
          <div class="gax-country-opt" data-val="Türkiye">Türkiye</div>
          <div class="gax-country-opt" data-val="Ukraine">Ukraine</div>
          <div class="gax-country-opt" data-val="United Kingdom">United Kingdom</div>
          <div class="gax-country-opt" data-val="Canada">Canada</div>
          <div class="gax-country-opt" data-val="Costa Rica">Costa Rica</div>
          <div class="gax-country-opt" data-val="Curaçao">Curaçao</div>
          <div class="gax-country-opt" data-val="Dominican Republic">Dominican Republic</div>
          <div class="gax-country-opt" data-val="Greenland">Greenland</div>
          <div class="gax-country-opt" data-val="Guatemala">Guatemala</div>
          <div class="gax-country-opt" data-val="Mexico">Mexico</div>
          <div class="gax-country-opt" data-val="Panama">Panama</div>
          <div class="gax-country-opt" data-val="Puerto Rico">Puerto Rico</div>
          <div class="gax-country-opt" data-val="United States">United States</div>
          <div class="gax-country-opt" data-val="United States Virgin Islands">United States Virgin Islands</div>
          <div class="gax-country-opt" data-val="American Samoa">American Samoa</div>
          <div class="gax-country-opt" data-val="Australia">Australia</div>
          <div class="gax-country-opt" data-val="Guam">Guam</div>
          <div class="gax-country-opt" data-val="New Zealand">New Zealand</div>
          <div class="gax-country-opt" data-val="Northern Mariana Islands">Northern Mariana Islands</div>
          <div class="gax-country-opt" data-val="Argentina">Argentina</div>
          <div class="gax-country-opt" data-val="Bolivia">Bolivia</div>
          <div class="gax-country-opt" data-val="Brazil">Brazil</div>
          <div class="gax-country-opt" data-val="Chile">Chile</div>
          <div class="gax-country-opt" data-val="Colombia">Colombia</div>
          <div class="gax-country-opt" data-val="Ecuador">Ecuador</div>
          <div class="gax-country-opt" data-val="Paraguay">Paraguay</div>
          <div class="gax-country-opt" data-val="Peru">Peru</div>
          <div class="gax-country-opt" data-val="Uruguay">Uruguay</div>
        </div>
      </div>
      <input type="hidden" id="gax-country-select" value="">

      <div id="gax-action-row">
        <button id="gax-analyse-btn">🔍 ANALYSE</button>
        <button id="gax-view-lesson-btn" style="display:none;">📖 Last Lesson</button>
      </div>

      <button id="gax-autoguide-btn" class="gax-autoguide-on">📖 Training Guides: ON</button>

      <div id="gax-last-lesson-wrap">
        <div class="gax-section-label">LAST LESSON</div>
        <div id="gax-last-lesson">—</div>
      </div>

      <div id="gax-usage-wrap">
        <div id="gax-usage-text"></div>
        <div id="gax-usage-bar-wrap">
          <div id="gax-usage-bar"></div>
        </div>
      </div>

      <div id="gax-chat-section">
        <div class="gax-section-label" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span style="display:flex;align-items:center;gap:6px;">GEOX CHAT <span id="gax-chat-mode-badge" style="background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:none;letter-spacing:normal;">World</span></span>
          <button id="gax-chat-expand-btn" title="Open in a bigger chat window" style="background:#1a1a2e;border:1px solid #2a2a3e;color:#00c9a7;font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;cursor:pointer;letter-spacing:.3px;">💬 Chat</button>
        </div>
        <div id="gax-chat-log"></div>
        <div id="gax-chat-input-row">
          <input id="gax-chat-input" placeholder="Ask GeoX..." type="text">
          <button id="gax-chat-send">↵</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Minimized "mini bar" — auto-shown once a game actually starts, so
  // the panel stops competing for screen space during play but Analyse
  // and Chat stay one click away. Built as a fully separate element
  // (not reusing the existing .collapsed CSS state) so its behavior is
  // simple and predictable regardless of what that styling does.
  const miniBar = document.createElement('div');
  miniBar.id = 'gax-mini-bar';
  miniBar.style.cssText = `
    display:none;position:fixed;top:16px;right:16px;z-index:2147483000;
    background:#0d0d18;border:1px solid #2a2a3e;border-radius:12px;
    padding:10px 12px;gap:8px;align-items:center;
    box-shadow:0 8px 24px rgba(0,0,0,0.4);
  `;
  miniBar.innerHTML = `
    <button id="gax-mini-analyse-btn" title="Analyse this scene" style="background:linear-gradient(135deg,#00c9a7,#00a87d);border:none;color:#080810;padding:5px 10px;border-radius:7px;font-weight:800;font-size:11px;cursor:pointer;white-space:nowrap;">🔍 Analyse</button>
    <button id="gax-mini-chat-btn" title="Open GeoX Chat" style="background:#1a1a2e;border:1px solid #2a2a3e;color:#00c9a7;padding:5px 10px;border-radius:7px;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap;">💬 Chat</button>
    <button id="gax-mini-expand-btn" title="Expand full panel" style="background:none;border:none;color:#5a5a7a;padding:4px 3px;cursor:pointer;font-size:12px;line-height:1;">⛶</button>
  `;
  document.body.appendChild(miniBar);
  makeDraggable(miniBar, miniBar);
  document.getElementById('gax-mini-analyse-btn').onclick = () => {
    // Auto-expand first — Analyse writes its result into the full
    // panel's #gax-result, which is invisible while minimized, so
    // clicking this while collapsed looked like it did nothing.
    userExpandedThisGame = true;
    showFullPanel();
    triggerAnalysis();
  };
  document.getElementById('gax-mini-chat-btn').onclick = () => openGeoXChatModal();
  document.getElementById('gax-mini-expand-btn').onclick = () => {
    userExpandedThisGame = true;
    showFullPanel();
  };

  // Make draggable
  makeDraggable(panel, document.getElementById('gax-header'));

  // Custom country dropdown
  const countryBtn  = document.getElementById('gax-country-btn');
  const countryList = document.getElementById('gax-country-list');
  const countryInput = document.getElementById('gax-country-select');
  const countryFilter = document.getElementById('gax-country-filter');
  if (countryBtn && countryList) {
    countryBtn.onclick = (e) => {
      e.stopPropagation();
      const opening = countryList.style.display === 'none';
      countryList.style.display = opening ? 'block' : 'none';
      if (opening && countryFilter) {
        countryFilter.value = '';
        countryList.querySelectorAll('.gax-country-opt').forEach(opt => { opt.style.display = ''; });
        setTimeout(() => countryFilter.focus(), 0);
      }
    };
    if (countryFilter) {
      countryFilter.onclick = (e) => e.stopPropagation();
      countryFilter.oninput = () => {
        const q = countryFilter.value.trim().toLowerCase();
        countryList.querySelectorAll('.gax-country-opt').forEach(opt => {
          opt.style.display = opt.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      };
    }
    countryList.querySelectorAll('.gax-country-opt').forEach(opt => {
      opt.onclick = () => {
        countryInput.value = opt.dataset.val;
        countryBtn.textContent = opt.textContent;
        countryList.style.display = 'none';
        // Switching map mode (e.g. World mode → New Zealand) makes any
        // prior chat answers actively misleading context, not just
        // stale — clear it out rather than let old guesses from a
        // completely different mode linger on screen.
        clearGeoXChat();
        updateChatModeBadge();
      };
    });
    document.addEventListener('click', () => { countryList.style.display = 'none'; });
  }

  // Make Sign In button work on click (not just Enter)
  document.getElementById('gax-analyse-btn').onclick = () => triggerAnalysis();
  document.getElementById('gax-disable-btn').onclick = disableScript;
  document.getElementById('gax-title-logo').onclick = (e) => {
    e.stopPropagation();
    toggleMinimize();
  };
  const autoGuideBtn = document.getElementById('gax-autoguide-btn');
  updateAutoGuideBtn(autoGuideBtn);
  autoGuideBtn.onclick = () => {
    gaxAutoGuide = !gaxAutoGuide;
    chrome.storage.local.set({ gax_auto_guide: gaxAutoGuide });
    updateAutoGuideBtn(autoGuideBtn);
  };
  document.getElementById('gax-chat-send').onclick = sendChat;
  document.getElementById('gax-chat-input').addEventListener('keydown', e => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') sendChat();
  }, true);
  document.getElementById('gax-chat-expand-btn').onclick = openGeoXChatModal;
}

// ── Draggable ──────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, startLeft, startTop;

  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = el.offsetLeft;
    startTop  = el.offsetTop;
    el.style.right  = 'auto';
    el.style.bottom = 'auto';

    const move = (e) => {
      const newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + e.clientX - startX));
      const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + e.clientY - startY));
      el.style.left = newLeft + 'px';
      el.style.top  = newTop  + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ── UI helpers ─────────────────────────────────────────────
function setStatus(text) {
  const el = document.getElementById('gax-status');
  if (el) el.textContent = text;
}

function isInRound() {
  const url = window.location.href;
  return url.includes('/game/') || url.includes('/challenge/');
}

function updateAnalyseAvailability() {
  const btn = document.getElementById('gax-analyse-btn');
  if (!btn) return;
  if (isInRound()) {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.title = '';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.45';
    btn.style.cursor = 'not-allowed';
    btn.title = 'Join a GeoGuessr round to use Analyse';
  }
}

function setResult(html) {
  const el = document.getElementById('gax-result');
  if (el) el.innerHTML = html;
}

function setResultLoading(on) {
  const btn = document.getElementById('gax-analyse-btn');
  if (btn) btn.disabled = on;
  if (on) setResult('<div class="gax-loading">Analysing...</div>');
}

let gaxChatHistory = [];
function updateChatModeBadge(){
  const country = document.getElementById('gax-country-select')?.value || '';
  const label = country || 'World';
  const sidebarBadge = document.getElementById('gax-chat-mode-badge');
  if (sidebarBadge) sidebarBadge.textContent = label;
  const modalBadge = document.getElementById('gax-chat-mode-badge-modal');
  if (modalBadge) modalBadge.textContent = label;
}
function clearGeoXChat(){
  gaxChatHistory = [];
  const sidebarLog = document.getElementById('gax-chat-log');
  if (sidebarLog) sidebarLog.innerHTML = '';
  const modalLog = document.getElementById('gax-chat-log-modal');
  if (modalLog) modalLog.innerHTML = '';
}
function chatAppend(sender, text) {
  gaxChatHistory.push({ sender, text });
  const sidebarLog = document.getElementById('gax-chat-log');
  if (sidebarLog) {
    const div = document.createElement('div');
    div.className = 'gax-msg gax-msg-' + sender;
    div.textContent = text;
    sidebarLog.appendChild(div);
    sidebarLog.scrollTop = sidebarLog.scrollHeight;
  }
  // The popup uses its own, uniquely-named classes (gax-modal-msg-*)
  // rather than reusing gax-msg-* — those sidebar classes picked up an
  // unrelated content.css rule that made the popup's text invisible,
  // so the popup needs styling nothing else in the codebase can touch.
  const modalLog = document.getElementById('gax-chat-log-modal');
  if (modalLog) {
    const div = document.createElement('div');
    div.className = 'gax-modal-msg gax-modal-msg-' + sender;
    div.textContent = text;
    modalLog.appendChild(div);
    modalLog.scrollTop = modalLog.scrollHeight;
  }
}

function updateHeader() {
  const badge = document.getElementById('gax-tier-badge');
  if (!badge) return;
  if (!gaxToken) {
    badge.textContent = 'Sign In';
    badge.className = '';
    badge.style.cssText = 'cursor:pointer;background:#1e1e2e;color:#8888aa;padding:2px 8px;border-radius:10px;font-size:10px;';
    badge.onclick = showLoginPrompt;
  } else if (gaxTier === 'pro') {
    badge.textContent = '⭐ Pro';
    badge.style.cssText = 'background:#7c3aed;color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;';
    badge.onclick = null;
  } else {
    badge.textContent = 'Free';
    badge.style.cssText = 'background:#1e1e2e;color:#8888aa;padding:2px 8px;border-radius:10px;font-size:10px;';
    badge.onclick = null;
  }
}

function showLoginPrompt() {
  chatAppend('sys', '👤 Please sign in via the 5kable extension icon in your browser toolbar.');
}

function toggleMinimize() {
  const panel = document.getElementById('gax-panel');
  if (!panel) return;
  panel.classList.toggle('gax-minimized');
}

function updateAutoGuideBtn(btn){
  btn.textContent = gaxAutoGuide ? '📖 Training Guides: ON' : '📖 Training Guides: OFF';
  btn.className = gaxAutoGuide ? 'gax-autoguide-on' : 'gax-autoguide-off';
}

function showMiniBar() {
  const panel = document.getElementById('gax-panel');
  const miniBar = document.getElementById('gax-mini-bar');
  if (panel) panel.style.display = 'none';
  if (miniBar) miniBar.style.display = 'flex';
}
function showFullPanel() {
  const panel = document.getElementById('gax-panel');
  const miniBar = document.getElementById('gax-mini-bar');
  if (panel) panel.style.display = '';
  if (miniBar) miniBar.style.display = 'none';
}

// ── Disable / Re-enable ──────────────────────────────────────
async function disableScript() {
  if (!confirm('Hide 5kable? Click the small ⏻ button that appears to bring it back any time.')) return;
  await chrome.storage.local.set({ gax_script_disabled: true });
  gaxDisabled = true;
  const panel = document.getElementById('gax-panel');
  if (panel) panel.remove();
  injectDisabledNub();
}

function injectDisabledNub() {
  if (document.getElementById('gax-disabled-nub')) return;
  const nub = document.createElement('div');
  nub.id = 'gax-disabled-nub';
  nub.title = '5kable is hidden — click to bring it back, drag to move';
  nub.textContent = '⏻';
  document.body.appendChild(nub);

  // Custom drag handling (rather than reusing makeDraggable) so we can
  // tell a genuine drag apart from a click — otherwise every drag would
  // also fire the re-enable click at mouseup.
  let dragged = false;
  let startX, startY, startLeft, startTop;

  nub.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragged = false;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = nub.offsetLeft;
    startTop  = nub.offsetTop;
    nub.style.right  = 'auto';
    nub.style.bottom = 'auto';

    const move = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - nub.offsetWidth,  startLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - nub.offsetHeight, startTop  + dy));
      nub.style.left = newLeft + 'px';
      nub.style.top  = newTop  + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  nub.addEventListener('click', async () => {
    if (dragged) return; // just finished dragging — don't also re-enable
    await chrome.storage.local.set({ gax_script_disabled: false });
    location.reload();
  });
}

async function loadUsage() {
  if (!gaxToken) return;
  try {
    const res = await apiCall('/ai/usage', { token: gaxToken });
    updateUsageDisplay(res.used, res.limit, res.tier, res.f7_used, res.teachings_used);
  } catch(e) {}
}

function updateUsageDisplay(used, limit, tier, f7Used, teachingsUsed) {
  const wrap = document.getElementById('gax-usage-wrap');
  const text = document.getElementById('gax-usage-text');
  const bar  = document.getElementById('gax-usage-bar');
  if (!wrap) return;
  if (tier === 'pro') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  // F7 captures are uncapped on all tiers — `limit` here is the
  // teachings-only daily cap (5/day free).
  const tRem = Math.max(0, limit - (teachingsUsed || 0));
  text.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
      <span style="color:#8888aa">📸 F7 Captures: ${f7Used||0} — unlimited</span>
      <span style="color:${tRem<=2?'#ff6b6b':'#8888aa'}">📖 Guides: ${teachingsUsed||0}/${limit}</span>
    </div>`;
  const pct = Math.round(((teachingsUsed||0) / limit) * 100);
  bar.style.width = pct + '%';
  bar.style.background = pct >= 90 ? '#ff6b6b' : pct >= 60 ? '#f0a500' : '#00c9a7';
}

// ── API helpers ────────────────────────────────────────────
async function apiCall(path, body) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'API_CALL',
      url: `${PLATFORM_API}${path}`,
      method: 'POST',
      body
    }, (resp) => {
      if (resp && resp.data) resolve(resp.data);
      else resolve({ error: resp?.error || 'API call failed' });
    });
  });
}

// ── Screenshot via background ──────────────────────────────
async function takeScreenshot() {
  // Hide our own panel (and the popup chat window / mini bar, if
  // present) before capturing — otherwise it gets baked permanently
  // into the training photo. Using display:none rather than
  // visibility:hidden here: visibility leaves the element in the
  // render tree, and on GPU-composited position:fixed overlays like
  // this panel, some browsers can still include a stale composited
  // layer in chrome.tabs.captureVisibleTab()'s snapshot even though it
  // looks hidden on screen.
  //
  // Each element's PREVIOUS display value is saved and restored,
  // rather than blindly resetting to '' — the panel may legitimately
  // already be display:none here (e.g. minimized to the mini bar), and
  // restoring to '' would wrongly pop the full panel back up after
  // every F7 capture while minimized.
  const panel = document.getElementById('gax-panel');
  const chatModal = document.getElementById('gax-chat-modal-overlay');
  const miniBar = document.getElementById('gax-mini-bar');
  const panelPrevDisplay = panel ? panel.style.display : null;
  const chatModalPrevDisplay = chatModal ? chatModal.style.display : null;
  const miniBarPrevDisplay = miniBar ? miniBar.style.display : null;

  if (panel) panel.style.display = 'none';
  if (chatModal) chatModal.style.display = 'none';
  if (miniBar) miniBar.style.display = 'none';

  // Actively confirm each element has actually finished being removed
  // from the render tree (offsetParent becomes null once display:none
  // has taken effect) instead of guessing a fixed delay — a large,
  // complex element (the full panel, with its dropdowns/inputs/chat
  // log) can take longer to fully reflow away than a small simple one
  // (the mini bar), so a delay long enough for one may not be long
  // enough for the other. Polls via rAF, capped so a stuck check can
  // never hang the capture indefinitely.
  async function waitUntilHidden(el, maxFrames = 30) {
    if (!el) return;
    for (let i = 0; i < maxFrames; i++) {
      if (el.offsetParent === null) return; // confirmed removed from layout
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  await Promise.all([
    waitUntilHidden(panel),
    waitUntilHidden(chatModal),
    waitUntilHidden(miniBar),
  ]);
  // One more paint cycle after the layout confirms hidden, so the
  // actual pixels are guaranteed to reflect it before we capture.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const image = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SCREENSHOT' }, (resp) => {
      if (resp && resp.image) {
        resolve(resp.image);
      } else {
        console.log('5kable: screenshot failed', resp?.error);
        resolve(null);
      }
    });
  });

  if (panel) panel.style.display = panelPrevDisplay;
  if (miniBar) miniBar.style.display = miniBarPrevDisplay;
  if (chatModal) chatModal.style.display = chatModalPrevDisplay;

  return image;
}

// ── Coords via direct API polling ─────────────────────────
function setupFetchIntercept() {
  async function pollCoords() {
    const url = window.location.href;
    const inGame = url.includes('/game/') || url.includes('/challenge/');

    // Just entered a game (was on the map/menu, now playing) — minimize
    // automatically so the panel stops competing for screen space,
    // unless the player already manually expanded it this game.
    if (inGame && !wasInGame) {
      wasInGame = true;
      userExpandedThisGame = false;
      showMiniBar();
    } else if (!inGame && wasInGame) {
      // Left the game (back to map/menu) — restore the full panel and
      // reset the manual-expand flag for the next game.
      wasInGame = false;
      userExpandedThisGame = false;
      showFullPanel();
    }

    if (!inGame) return;
    const token = window.location.pathname.split('/').pop();
    if (!token || token.length < 5) return;
    try {
      const res  = await fetch(`/api/v3/games/${token}`);
      const data = await res.json();
      if (data && data.rounds) {
        const round = data.round || 1;
        const idx   = Math.max(0, round - 1);
        const r     = data.rounds[idx];
        if (r && r.lat !== undefined && r.lng !== undefined) {
          if (!_gax_coords || _gax_coords.lat !== r.lat || _gax_coords.round !== round) {
            // Preserve the round we're leaving before overwriting — without
            // this, the background poller can update _gax_coords to the new
            // round's location before the round-change handler below even
            // notices the round number changed, causing teaching guides to
            // describe the wrong (just-loaded) round instead of the one
            // that was actually just played.
            if (_gax_coords && _gax_coords.round !== round) {
              _gax_prev_coords = { ..._gax_coords };
            }
            _gax_coords = { lat: r.lat, lng: r.lng, round, mapName: data.mapName };
            console.log('5kable: polled coords', r.lat.toFixed(4), r.lng.toFixed(4), 'round', round);
          }
        }
      }
    } catch(e) {}
  }
  // Poll every 2 seconds
  setInterval(pollCoords, 2000);
  pollCoords();
}

// ── Round detection ────────────────────────────────────────
function setupRoundDetection() {
  let lastRound = 0;

  setInterval(() => {
    const url = window.location.href;
    if (!url.includes('/game/') && !url.includes('/challenge/')) return;
    const currentRound = _gax_coords?.round || 0;
    if (currentRound === lastRound || currentRound === 0) return;

    const prevRound = lastRound;
    lastRound = currentRound;
    roundActive = true;

    // Reset status on new round
    setStatus('Round ' + currentRound + ' — Press Analyse or F7');
    console.log('5kable: new round', currentRound, 'prev:', prevRound);

    // A new round means a brand new, un-guessed scene — the previous
    // round's answer is no longer "current" and shouldn't be what GeoX
    // draws on if the player asks about what they're looking at right
    // now, before guessing. Clear it here; if a guess WAS just made on
    // the round that ended, the block below immediately re-populates
    // this with that round's real result for post-round discussion —
    // this only actually stays empty for a genuinely fresh scene.
    lastAnalysisText = '';
    lastAnalysisRound = currentRound;
    chrome.storage.local.set({ gax_last_analysis: '' });
    if (prevRound > 0 && gaxChatHistory.length) {
      clearGeoXChat();
      chatAppend('sys', '🆕 New round — ask away, GeoX will analyse the scene automatically the first time you ask.');
    }

    // If we moved from round N to round N+1, a guess was made on round N
    if (prevRound > 0 && currentRound > prevRound) {
      // Use the preserved previous-round coords, NOT the live _gax_coords —
      // by this point _gax_coords has almost always already been overwritten
      // with the NEW round's location by the background poller, since round
      // detection itself relies on that same variable having updated. Using
      // it here would describe the wrong round's location entirely.
      const correctCoords = (_gax_prev_coords && _gax_prev_coords.round === prevRound)
        ? {..._gax_prev_coords}
        : (_gax_coords ? {..._gax_coords} : null);
      console.log('5kable: guess detected (round changed), f7Image:', !!_gax_f7_image, 'pending:', !!pendingTeach, 'guessLat:', _gax_guess_lat);
      const saved = {
        coords:   correctCoords,
        guessLat: _gax_guess_lat,
        guessLng: _gax_guess_lng
      };

      if (saved?.coords) {  // always trigger teaching if we have coords
        console.log('5kable: triggering teaching in 1s, guessCoords:', saved.guessLat, saved.guessLng);
        setStatus('Checking region...');
        setTimeout(async () => {
          setStatus('Loading training guide...');
          // Determine correct/wrong by REGION (state + country), not raw
          // distance — a state like Western Australia is enormous, so two
          // points hundreds of km apart can still both be the "right"
          // region and shouldn't be marked wrong.
          if (saved.guessLat && saved.guessLng && saved.coords) {
            const R = 6371;
            const dLat = (saved.coords.lat - saved.guessLat) * Math.PI / 180;
            const dLng = (saved.coords.lng - saved.guessLng) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(saved.guessLat*Math.PI/180)*Math.cos(saved.coords.lat*Math.PI/180)*Math.sin(dLng/2)**2;
            const dist = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));

            let isCorrect = false;
            try {
              const [correctGeo, guessGeo] = await Promise.all([
                reverseGeocode(saved.coords.lat, saved.coords.lng),
                reverseGeocode(saved.guessLat, saved.guessLng)
              ]);
              const sameCountry = correctGeo?.country && guessGeo?.country && correctGeo.country === guessGeo.country;
              if (correctGeo?.state && guessGeo?.state) {
                // Most countries: compare at state/region level, since
                // large countries (Australia, USA, Russia, Brazil...) can
                // easily have two points hundreds of km apart that are
                // still both correctly "the same region."
                isCorrect = !!(sameCountry && correctGeo.state === guessGeo.state);
              } else {
                // Small or administratively flat countries (Singapore,
                // Monaco, Vatican, Luxembourg, etc.) often have no
                // state/region field at all in the geocoding data — for
                // those, fall back to the distance threshold instead of
                // treating every guess as automatically wrong.
                isCorrect = !!sameCountry && dist < 150;
              }
              console.log('5kable: region check — correct:', correctGeo?.state, correctGeo?.country, '| guess:', guessGeo?.state, guessGeo?.country, '| match:', isCorrect, '| dist:', dist + 'km');
              // Cheap baseline context for "Ask GeoX" — runs every round
              // regardless of the Training Guides toggle or whether the
              // guess was right or wrong, so the chat always has at
              // least the real location names and distance to work
              // with. Gets overwritten with the richer AI-generated
              // version further down whenever the full teaching flow
              // actually runs.
              lastAnalysisText = buildLightContextText(correctGeo, guessGeo, dist, isCorrect);
              lastAnalysisRound = prevRound;
              chrome.storage.local.set({ gax_last_analysis: lastAnalysisText });
              // Log this result for the per-country region-guessing
              // accuracy stats — the real, gameplay-derived confidence
              // measure, not a manual self-rating.
              if (gaxToken && correctGeo?.country){
                apiCall('/guess/log', {
                  token: gaxToken,
                  country: correctGeo.country,
                  correct_region: correctGeo.state || null,
                  guessed_region: guessGeo?.state || null,
                  is_correct: isCorrect
                }).catch(() => {});
              }
            } catch (e) {
              // Geocoding failed — fall back to the old distance threshold
              // rather than silently treating every guess as correct/wrong
              isCorrect = dist < 150;
              console.log('5kable: region check failed, falling back to distance threshold:', e.message);
            }

            if (isCorrect) {
              console.log('5kable: guess was in the correct region (' + dist + 'km), skipping teaching');
              setStatus('✓ Correct Region! Awaiting Next Round');
              _gax_guess_lat = null;
              _gax_guess_lng = null;
              return;
            }
            console.log('5kable: wrong region (' + dist + 'km), showing teaching');
          } else if (!saved.guessLat) {
            console.log('5kable: no guess coords, showing teaching without correctness check');
          }
          // (Removed: this used to do `_gax_f7_image = saved.image`, but
          // `saved` never actually had an `.image` property — that line
          // was silently wiping out the real F7 screenshot captured
          // during the round, right before triggerResultTeaching() needed
          // it to avoid taking a "live" screenshot of the wrong round.)
          _gax_f7_coords      = saved.coords;
          _gax_guess_lat      = saved.guessLat || null;
          _gax_guess_lng      = saved.guessLng || null;
          if (gaxAutoGuide) {
            triggerResultTeaching(saved.coords);
          } else {
            console.log('5kable: auto-guide is off, skipping teaching');
            setStatus('Round ' + currentRound + ' — Press Analyse or F7');
          }
        }, 1000);
      } else {
        console.log('5kable: no F7 image to teach with');
        setStatus('Round ' + currentRound + ' — Press Analyse or F7');
      }
    } else {
      // New game started or first round — clear everything
      _gax_f7_image    = null;
      _gax_scene_image = null;
      _gax_f7_coords   = null;
      pendingTeach     = null;
    }
  }, 1000);

  // Capture player's guess pin location from drag.js fetch intercept
  window.addEventListener('gax_guess', (e) => {
    console.log('5kable: gax_guess fired, lat:', e.detail.lat);
    _gax_guess_lat = e.detail.lat;
    _gax_guess_lng = e.detail.lng;
  });
}

// ── Hotkeys ────────────────────────────────────────────────
// Typing in any 5kable text input (chat, teaching popup chat,
// popup modal chat) was still triggering GeoGuessr's own keyboard
// shortcuts underneath — e.g. "f" for fullscreen, "r" to reset the
// view. Intercepting on window itself with capture=true, at
// document_start (before GeoGuessr's own scripts run at all), is what
// actually wins that race.
//
// Important side effect this creates: stopping propagation at window
// prevents the event from ever continuing down to the input element
// itself — which means each input's OWN separate Enter-to-send keydown
// listener never fires anymore either, since it never receives the
// event. Rather than fight that, this handler now performs Enter-to-
// send itself, by clicking each input's real send button directly —
// that works regardless of whether the actual send logic lives in a
// closure this function can't otherwise reach (like the teaching
// popup's chat, which is scoped inside showTeachingPopup()).
const GAX_TEXT_INPUT_IDS = ['gax-chat-input', 'gax-chat-input-modal', 'gax-teach-chat-input'];
const GAX_INPUT_TO_SEND_BTN = {
  'gax-chat-input': 'gax-chat-send',
  'gax-chat-input-modal': 'gax-chat-send-modal',
  'gax-teach-chat-input': 'gax-teach-chat-send',
};
function setupGlobalInputGuard() {
  ['keydown', 'keyup', 'keypress'].forEach(eventType => {
    window.addEventListener(eventType, (e) => {
      const active = document.activeElement;
      if (!active || !GAX_TEXT_INPUT_IDS.includes(active.id)) return;
      e.stopPropagation();
      if (eventType === 'keydown' && e.key === 'Enter') {
        e.preventDefault();
        const btnId = GAX_INPUT_TO_SEND_BTN[active.id];
        document.getElementById(btnId)?.click();
      }
    }, true);
  });
}

function setupHotkeys() {
  document.addEventListener('keydown', async (e) => {
    if (gaxDisabled) return;
    if (e.key === 'F7') {
      e.preventDefault();
      if (!gaxToken) { setStatus('Please sign in first'); return; }
      setStatus('Capturing scene...');
      console.log('5kable: F7 pressed, taking screenshot...');
      const imageB64 = await takeScreenshot();
      console.log('5kable: screenshot result:', imageB64 ? imageB64.length + ' chars' : 'NULL');
      if (!imageB64) { setStatus('✗ Capture failed'); return; }

      // Always save locally for teaching popup — BEFORE upload attempt
      _gax_scene_image = imageB64;
      _gax_f7_image    = imageB64;
      _gax_f7_coords   = _gax_coords ? {..._gax_coords} : null;
      console.log('5kable: F7 image saved locally, size:', imageB64.length);
      const sizeKB = Math.round(imageB64.length * 0.75 / 1024);
      setStatus(`✓ Captured (${sizeKB}KB)`);

      if (_gax_coords) {
        try {
          const geo = await reverseGeocode(_gax_coords.lat, _gax_coords.lng);
          const country = geo?.country || '';
          const state   = geo?.state   || '';
          console.log('5kable: looking up pano_id for', country, state);
          const panoRes = await apiCall('/scenes/pano_lookup', {
            lat: _gax_coords.lat, lng: _gax_coords.lng, token: gaxToken
          });
          if (!panoRes.pano_id) {
            console.log('5kable: no pano_id found, skipping library upload');
            setStatus(`✓ Captured (${sizeKB}KB) > No Street View coverage here`);
            return;
          }
          console.log('5kable: uploading pano_id for', country, state);
          const res = await apiCall('/scenes/upload', {
            pano_id: panoRes.pano_id, country, state,
            lat: _gax_coords.lat, lng: _gax_coords.lng,
            token: gaxToken
          });
          console.log('5kable: upload result:', res);
          if (res.uploaded) {
            setStatus(`✓ Captured > Added To Library`);
            loadUsage();
          } else if (res.code === 'limit') {
            // Upload limit hit but scene is still saved locally for teaching
            setStatus(`✓ Captured (daily upload limit reached) > Not Added To Library`);
          } else {
            setStatus(`✓ Captured — upload: ${res.error || 'failed'}`);
          }
        } catch(e) {
          console.log('5kable: upload error:', e.message);
          setStatus(`✓ Captured (${sizeKB}KB)`);
        }
      } else {
        setStatus(`✓ Captured — no coords yet`);
      }
    }
    if (e.key === 'F8') { e.preventDefault(); triggerAnalysis(); }
  });
}

// ── Reverse geocode ────────────────────────────────────────
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': '5kable/1.0' } }
    );
    const d = await res.json();
    const addr = d.address || {};

    // State field varies by country/territory — try all possible fields
    const state = addr.state ||
                  addr.territory ||
                  addr.province ||
                  addr.region ||
                  addr.state_district ||
                  addr.county ||
                  '';

    let finalState = state;

    // For Australia, also try to get state from coordinate-based detection
    // since Nominatim sometimes returns wrong/missing state for AU territories
    if (addr.country_code === 'au' && !finalState) {
      finalState = getAusStateFromCoords(lat, lng);
    }

    // Special municipalities (Taiwan's Kaohsiung/Taipei/New Taipei/Taichung/
    // Tainan, and similar direct-governed cities elsewhere) are simultaneously
    // the top-level region AND the city — OSM/Nominatim often puts the name
    // under `city` for these instead of any of the fields above, which left
    // `state` empty and caused these to get mis-tagged as "unknown" region.
    // Only fall back to city as the region when nothing else was found, so
    // this can't override a real state/county for ordinary countries.
    if (!finalState && addr.city && addr.city !== addr.country) {
      finalState = addr.city;
    }
    if (!finalState && addr.municipality) {
      finalState = addr.municipality;
    }

    // City-states (Singapore, Monaco, Vatican City, etc.) have no
    // state/province/county layer at all in OSM's model — the most
    // specific real subdivision is a planning area / district, tagged as
    // suburb, city_district, borough, or neighbourhood depending on the
    // area. Without this, every single capture in a city-state falls
    // through to "unknown", since there's nothing between country and
    // street for it to land on.
    if (!finalState) {
      finalState = addr.suburb || addr.city_district || addr.borough ||
                   addr.neighbourhood || addr.town || addr.village || '';
    }

    return {
      country: addr.country || '',
      state:   finalState,
      city:    addr.city || addr.town || addr.village || addr.suburb || '',
    };
  } catch(e) { return null; }
}

function getAusStateFromCoords(lat, lng) {
  if (!lat || !lng) return '';
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (lat < -39.5 && lng > 143.5 && lng < 149.5) return 'Tasmania';
  if (lng < 129) return 'Western Australia';
  if (lng >= 129 && lng <= 138 && lat > -25.996) return 'Northern Territory';
  if (lng >= 129 && lng <= 141 && lat <= -25.996) return 'South Australia';
  if (lng > 138 && lat > -29.0 && lng <= 153) return 'Queensland';
  if (lng > 141) {
    if (lng < 144 && lat < -34.0) return 'Victoria';
    if (lng >= 144 && lng < 146 && lat < -36.0) return 'Victoria';
    if (lng >= 146 && lng < 148 && lat < -36.1) return 'Victoria';
    if (lng >= 148 && lng < 149 && lat < -37.0) return 'Victoria';
    if (lng >= 149 && lat < -37.5) return 'Victoria';
    if (lat <= -29.0) return 'New South Wales';
  }
  return '';
}

// ── Analyse ────────────────────────────────────────────────
async function triggerAnalysis() {
  if (isAnalysing) return;
  if (!isInRound()) {
    setStatus('Join a GeoGuessr round to use Analyse');
    return;
  }
  if (!gaxToken) { showLoginPrompt(); return; }
  // Block free users immediately - don't even take screenshot
  if (gaxTier !== 'pro') {
    setResult(`<div style="text-align:center;padding:12px;">
      <div style="font-size:20px;margin-bottom:6px;">🔒</div>
      <div style="font-weight:700;color:#e0e0f0;margin-bottom:4px;">Pro Feature</div>
      <div style="font-size:11px;color:#8888aa;margin-bottom:10px;">Unlimited AI analysis with exact GPS coordinates</div>
      <button onclick="window.open('https://5kable.net/#pricing')" style="padding:8px 16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">Upgrade to Pro</button>
    </div>`);
    setStatus('🔒 Analyse is a Pro feature');
    isAnalysing = false;
    return;
  }

  isAnalysing = true;
  setResultLoading(true);
  setStatus('Taking screenshot...');

  const imageB64 = await takeScreenshot();
  if (!imageB64) {
    setStatus('Screenshot failed');
    setResultLoading(false);
    isAnalysing = false;
    return;
  }
  lastImageB64 = imageB64;
  _gax_scene_image = imageB64;

  const forcedCountry = document.getElementById('gax-country-select')?.value || '';

  // If we have coords, reverse geocode first so Claude knows exactly where it is
  let knownLocation = '';
  let displayLocation = '';
  if (_gax_coords) {
    setStatus('Getting location...');
    const geo = await reverseGeocode(_gax_coords.lat, _gax_coords.lng);
    if (geo) {
      const parts = [geo.city, geo.state, geo.country].filter(Boolean);
      knownLocation = parts.join(', ');
      displayLocation = parts.slice(-2).join(', '); // state, country
    }
  }

  setStatus('Asking 5kable...');
  console.log('5kable: knownLocation:', knownLocation, 'coords:', _gax_coords);

  // If location is known, show it immediately and ask Claude to explain WHY
  if (knownLocation) {
    const locParts = knownLocation.split(', ');
    const state = locParts.length >= 2 ? locParts[locParts.length - 2] : '';
    const country = locParts[locParts.length - 1] || '';

    setResult(`<div style="margin-bottom:6px">
      <div style="font-size:16px;font-weight:800;color:#e0e0f0">📍 ${knownLocation}</div>
      <div style="font-size:11px;color:#00c9a7;margin-top:2px">● Location confirmed via coordinates</div>
    </div>
    <div style="font-size:11px;color:#5a5a7a">Asking 5kable for visual clues...</div>`);

    try {
      const data = await apiCall('/ai/analyse', {
        token: gaxToken,
        image: imageB64,
        country: forcedCountry || country,
        known_location: knownLocation
      });

      if (data.result) {
        const keyClue = data.result.match(/^KEY CLUE:\s*(.+)$/m)?.[1]?.trim();
        const detail  = data.result.match(/^DETAIL:\s*([\s\S]+?)(?:\n[A-Z]|$)/m)?.[1]?.trim();
        const pole    = data.result.match(/^POLE DESCRIPTION:\s*(.+)$/m)?.[1]?.trim();

        let html = `<div style="margin-bottom:6px">
          <div style="font-size:16px;font-weight:800;color:#e0e0f0">📍 ${knownLocation}</div>
          <div style="font-size:11px;color:#00c9a7;margin-top:2px">● Location confirmed via coordinates</div>
        </div>`;
        if (keyClue) html += `<div style="background:rgba(0,201,167,0.08);border:1px solid rgba(0,201,167,0.2);border-radius:8px;padding:8px 10px;margin-bottom:8px"><div style="font-size:9px;color:#00c9a7;font-weight:700;letter-spacing:1px;margin-bottom:3px">🔑 KEY CLUE</div><div style="font-size:12px;line-height:1.5">${keyClue}</div></div>`;
        if (detail) html += `<div style="font-size:12px;color:#c0c0d8;line-height:1.6">${detail}</div>`;
        if (pole && !pole.toLowerCase().includes('distant') && !pole.toLowerCase().includes('not visible')) {
          html += `<div style="font-size:11px;color:#5a5a7a;margin-top:6px">🔍 ${pole}</div>`;
        }
        setResult(html);
        lastAnalysisText = knownLocation + '. ' + (keyClue || '');
        lastAnalysisRound = _gax_coords?.round || 0;
        chrome.storage.local.set({ gax_last_analysis: lastAnalysisText });
        setStatus('Analysis complete');
        if (data.remaining >= 0) updateUsageDisplay(FREE_DAILY_LIMIT - data.remaining, FREE_DAILY_LIMIT, gaxTier);
      }
    } catch(e) {
      setStatus('Analysis complete');
    }
    setResultLoading(false);
    isAnalysing = false;
    return;
  }

  // No coords — let Claude guess
  try {
    const data = await apiCall('/ai/analyse', {
      token: gaxToken,
      image: imageB64,
      country: forcedCountry
    });

    if (data.code === 'pro') {
      setResult(`<div class="gax-limit" style="text-align:center;padding:12px;">
        <div style="font-size:20px;margin-bottom:6px;">🔒</div>
        <div style="font-weight:700;color:#e0e0f0;margin-bottom:4px;">Pro Feature</div>
        <div style="font-size:11px;color:#8888aa;margin-bottom:10px;">Unlimited AI analysis with exact GPS coordinates</div>
        <button onclick="window.open('https://5kable.net/#pricing')" style="padding:8px 16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">Upgrade to Pro</button>
      </div>`);
      setStatus('🔒 Analyse is a Pro feature');
    } else if (data.code === 'limit') {
      setResult(`<div class="gax-limit">
        <div>🔒 Daily limit reached</div>
        <div style="font-size:11px;margin-top:4px;color:#8888aa">${data.message}</div>
        <button onclick="window.open('https://5kable.net')" style="margin-top:8px;padding:6px 12px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Upgrade to Pro</button>
      </div>`);
      setStatus('Daily limit reached');
    } else if (data.code === 'auth') {
      showLoginPrompt();
      setStatus('Not signed in');
    } else if (data.result) {
      console.log('5kable: raw result:', data.result.substring(0, 300));
      setResult(formatResult(data.result));
      lastAnalysisText = data.result;
      lastAnalysisRound = _gax_coords?.round || 0;
      chrome.storage.local.set({ gax_last_analysis: lastAnalysisText });
      setStatus('Analysis complete');
      if (data.remaining >= 0) updateUsageDisplay(FREE_DAILY_LIMIT - data.remaining, FREE_DAILY_LIMIT, gaxTier);
    } else {
      setResult('<div style="color:#ff6b6b">' + (data.error || 'No response') + '</div>');
      setStatus('Error');
    }
  } catch(e) {
    setResult('<div style="color:#ff6b6b">Server error: ' + e.message + '</div>');
    setStatus('Error');
  }

  setResultLoading(false);
  isAnalysing = false;
}

async function checkForUpdate() {
  try {
    const res = await fetch('https://5kable.net/version.json?t=' + Date.now());
    const data = await res.json();
    const current = chrome.runtime.getManifest().version;
    if (data.version && data.version !== current) {
      // Show update banner
      const existing = document.getElementById('gax-update-banner');
      if (existing) return;
      const banner = document.createElement('div');
      banner.id = 'gax-update-banner';
      banner.style.cssText = `
        background:linear-gradient(135deg,rgba(124,58,237,0.2),rgba(0,201,167,0.1));
        border:1px solid rgba(124,58,237,0.4);
        border-radius:8px;padding:8px 10px;margin:6px 0;
        font-size:11px;display:flex;align-items:center;justify-content:space-between;gap:8px;
      `;
      banner.innerHTML = `
        <span>🆕 <strong>v${data.version}</strong> available — ${data.release_notes || 'Update ready'}</span>
        <a href="${data.download_url}" target="_blank" style="background:#7c3aed;color:#fff;padding:3px 8px;border-radius:6px;text-decoration:none;font-size:10px;font-weight:700;flex-shrink:0;">Download</a>
      `;
      const panel = document.getElementById('gax-result');
      if (panel) panel.parentNode.insertBefore(banner, panel);
    }
  } catch(e) {}
}

function formatResult(text) {
  if (!text) return '';
  text = text.replace(/#{1,3}\s*/g, '').replace(/\*\*/g, '').replace(/\*/g, '');

  const location   = text.match(/^LOCATION:\s*(.+)$/m)?.[1]?.trim();
  const confidence = text.match(/^CONFIDENCE:\s*(.+)$/m)?.[1]?.trim();
  const keyClue    = text.match(/^KEY CLUE:\s*(.+)$/m)?.[1]?.trim();
  const detail     = text.match(/^DETAIL:\s*([\s\S]+?)(?:\n[A-Z]|$)/m)?.[1]?.trim();
  const pole       = text.match(/^POLE DESCRIPTION:\s*(.+)$/m)?.[1]?.trim();

  if (location || keyClue) {
    let html = '';
    if (location) {
      const confColor = (confidence||'').toLowerCase().includes('high') ? '#00c9a7' :
                        (confidence||'').toLowerCase().includes('medium') ? '#f0a500' : '#c0c0d8';
      html += `<div style="margin-bottom:8px"><div style="font-size:15px;font-weight:800;color:#e0e0f0">📍 ${location}</div>${confidence ? `<div style="font-size:11px;color:${confColor};margin-top:2px">● ${confidence}</div>` : ''}</div>`;
    }
    if (keyClue) {
      html += `<div style="background:rgba(0,201,167,0.08);border:1px solid rgba(0,201,167,0.2);border-radius:8px;padding:8px 10px;margin-bottom:8px"><div style="font-size:9px;color:#00c9a7;font-weight:700;letter-spacing:1px;margin-bottom:3px">🔑 KEY CLUE</div><div style="font-size:12px;line-height:1.5">${keyClue}</div></div>`;
    }
    if (detail) html += `<div style="font-size:12px;color:#c0c0d8;line-height:1.6">${detail}</div>`;
    if (pole && !pole.toLowerCase().includes('not visible') && !pole.toLowerCase().includes('no clear')) {
      html += `<div style="font-size:11px;color:#5a5a7a;margin-top:6px">🔍 ${pole}</div>`;
    }
    return html;
  }

  // Fallback — style STEP headers
  return text.split('\n').filter(l => l.trim()).map(l => {
    if (l.match(/^STEP \d/)) return `<div style="font-size:10px;font-weight:700;color:#00c9a7;letter-spacing:1px;margin-top:8px;margin-bottom:2px">${l}</div>`;
    return `<div style="font-size:12px;color:#c0c0d8;line-height:1.6;margin-bottom:3px">${l}</div>`;
  }).join('');
}

// ── Teaching popup ─────────────────────────────────────────
async function triggerResultTeaching(correctCoords) {
  console.log('5kable: triggerResultTeaching called, token:', !!gaxToken, 'coords:', correctCoords);
  if (!gaxToken) return;

  const coordsToUse = correctCoords || _gax_coords;

  // Prefer the F7 screenshot actually captured during the round being
  // taught (if the round numbers match) over a fresh "live" screenshot —
  // by the time this runs, the next round has often already loaded on
  // screen, so a live capture here could show the WRONG round entirely.
  let sceneImage = null;
  if (_gax_f7_image && _gax_f7_coords?.round === coordsToUse?.round) {
    console.log('5kable: using F7 screenshot from this round for teaching');
    sceneImage = _gax_f7_image;
  } else {
    console.log('5kable: no matching F7 screenshot, taking live screenshot for teaching');
    sceneImage = await takeScreenshot();
  }
  if (!sceneImage) { console.log('5kable: screenshot unavailable for teaching'); return; }

  try {
    const correctLat = coordsToUse?.lat;
    const correctLng = coordsToUse?.lng;
    console.log('5kable: using coords', correctLat, correctLng);

    if (!correctLat || !correctLng) {
      console.log('5kable: no coords available');
      return;
    }

    // Use intercepted guess coords
    let guessLat = _gax_guess_lat || pendingTeach?.guessLat || null;
    let guessLng = _gax_guess_lng || pendingTeach?.guessLng || null;
    console.log('5kable: guess coords:', guessLat, guessLng);

    const geo = await reverseGeocode(correctLat, correctLng);
    const correctName = [geo?.city, geo?.state, geo?.country].filter(Boolean).join(', ');
    const state   = geo?.state   || '';
    const country = geo?.country || '';
    console.log('5kable: teaching for', correctName, '| state:', state, '| country:', country);

    // Get ref images from correct location
    let refImages = [];
    try {
      const refsData = await apiCall('/scenes/refs', { state, country, lat: correctLat, lng: correctLng, limit: 2 });
      refImages = refsData.images || [];
    } catch(e) {}

    // Get ref image from where player guessed
    let guessRefImage = null;
    let guessRefSource = null;
    let guessLocationName = '';
    if (guessLat && guessLng) {
      try {
        const guessGeo = await reverseGeocode(guessLat, guessLng);
        const guessState   = guessGeo?.state   || '';
        const guessCountry = guessGeo?.country || '';
        guessLocationName  = [guessState, guessCountry].filter(Boolean).join(', ');
        // Only show guess ref if it's a DIFFERENT location to correct
        if (guessState !== state || guessCountry !== country) {
          const guessRefs = await apiCall('/scenes/refs', { state: guessState, country: guessCountry, lat: guessLat, lng: guessLng, limit: 1 });
          if (guessRefs.images?.length > 0) {
            guessRefImage  = guessRefs.images[0];
            guessRefSource = guessRefs.images[0].source || 'community';
            console.log('5kable: got guess ref for', guessLocationName, '(source:', guessRefSource + ')');
          } else {
            console.log('5kable: no ref images for guess location', guessLocationName);
          }
        } else {
          console.log('5kable: guess was correct state, skipping guess ref image');
        }
      } catch(e) {
        console.log('5kable: could not get guess ref:', e.message);
      }
    }

    // Get teaching from server
    console.log('5kable: calling teaching API...');
    const teachData = await apiCall('/ai/teaching', {
      token: gaxToken,
      image: sceneImage,
      correct_name: correctName,
      country: country,
      distance_km: '?',
      ref_images: refImages
    });
    console.log('5kable: teachData full:', JSON.stringify(teachData).substring(0, 500));
    if (teachData.code === 'limit') {
      console.log('5kable: teaching limit reached');
      // Show limit popup with countdown
      showTeachingLimitPopup();
      setStatus('📖 Daily guide limit reached');
      return;
    }
    if (!teachData.teaching) { console.log('5kable: no teaching text, keys:', Object.keys(teachData)); return; }

    const rawTeaching = teachData.teaching.replace(/\\n/g, '\n');
    console.log('5kable: raw teaching text:', rawTeaching.substring(0, 400));

    // Parse teaching — strip markdown bold markers first
    const lines = rawTeaching.split('\n').filter(l => l.trim()).map(l =>
      l.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()
    );
    let keyClue = '', bullets = [], tricky = '';
    for (const line of lines) {
      if (line.startsWith('KEY CLUE:')) keyClue = line.replace('KEY CLUE:', '').trim();
      else if (line.match(/^LESSON \d:/)) bullets.push(line.replace(/^LESSON \d:/, '').trim());
      else if (line.startsWith('TRICKY:')) tricky = line.replace('TRICKY:', '').trim();
    }
    console.log('5kable: parsed keyClue:', keyClue, 'bullets:', bullets, 'tricky:', tricky);

    // Calculate distance
    let distanceKm = null;
    if (guessLat && guessLng) {
      const R = 6371;
      const dLat = (correctLat - guessLat) * Math.PI / 180;
      const dLng = (correctLng - guessLng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(guessLat*Math.PI/180)*Math.cos(correctLat*Math.PI/180)*Math.sin(dLng/2)**2;
      distanceKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }

    console.log('5kable: showing popup, keyClue:', keyClue, 'bullets:', bullets.length, 'dist:', distanceKm);
    showTeachingPopup(correctName, state, sceneImage, refImages, guessRefImage, guessLocationName, keyClue, bullets, tricky, distanceKm, guessRefSource);
    setStatus('Round ' + (_gax_coords?.round || '') + ' — Press Analyse or F7');
    loadUsage(); // refresh guide counter

    // Save for "View Last Lesson" button — also syncs lastAnalysisText so
    // the persistent sidebar "Ask GeoX" chat has this round's real
    // context too, not just the teaching popup's own local chat. Before
    // this fix, lastAnalysisText was only ever set by the manual
    // "Analyse" button, so the sidebar chat could be answering with
    // stale data from a completely different, earlier round.
    lastLesson = { correctName, state, sceneImg: sceneImage, refImages, guessRefImage, guessLocationName, keyClue, bullets, tricky, distanceKm, guessRefSource };
    lastAnalysisText = buildTeachingContextText(lastLesson);
    lastAnalysisRound = coordsToUse?.round || 0;
    chrome.storage.local.set({ gax_last_analysis: lastAnalysisText });
    const lessonEl = document.getElementById('gax-last-lesson');
    const lessonBtn = document.getElementById('gax-view-lesson-btn');
    if (lessonEl) lessonEl.textContent = keyClue || correctName;
    if (lessonBtn) {
      lessonBtn.style.display = 'block';
      lessonBtn.onclick = () => {
        if (lastLesson) showTeachingPopup(lastLesson.correctName, lastLesson.state, lastLesson.sceneImg, lastLesson.refImages, lastLesson.guessRefImage, lastLesson.guessLocationName, lastLesson.keyClue, lastLesson.bullets, lastLesson.tricky, lastLesson.distanceKm, lastLesson.guessRefSource);
      };
    }
    _gax_f7_image  = null;
    _gax_f7_coords = null;
    _gax_guess_lat = null;
    _gax_guess_lng = null;
  } catch(e) {
    console.log('5kable: teaching error:', e.message, e.stack);
    setStatus('Round ' + (_gax_coords?.round || '') + ' — Press Analyse or F7');
  }
}

function showTeachingLimitPopup() {
  const existing = document.getElementById('gax-teach-overlay');
  if (existing) existing.remove();

  // Calculate time until midnight reset
  function getTimeUntilReset() {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const diff = midnight - now;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  const overlay = document.createElement('div');
  overlay.id = 'gax-teach-overlay';
  overlay.innerHTML = `
    <div id="gax-teach-box" style="max-width:380px;text-align:center;">
      <div id="gax-teach-header" style="padding:24px;">
        <div style="font-size:36px;margin-bottom:8px;">📖</div>
        <div style="font-size:18px;font-weight:800;color:#e0e0f0;margin-bottom:4px;">Daily Limit Reached</div>
        <div style="font-size:12px;color:#8888aa;">You've used all 10 free training guides today</div>
      </div>
      <div id="gax-teach-body" style="padding:0 24px 24px;">
        <div style="background:#1a1a2e;border:1px solid #2a2a3e;border-radius:12px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;color:#8888aa;margin-bottom:6px;">Resets in</div>
          <div id="gax-countdown" style="font-size:28px;font-weight:800;color:#00c9a7;font-variant-numeric:tabular-nums;">${getTimeUntilReset()}</div>
          <div style="font-size:11px;color:#5a5a7a;margin-top:4px;">Limits reset at midnight</div>
        </div>
        <div style="font-size:12px;color:#8888aa;margin-bottom:16px;">Upgrade to Pro for unlimited training guides every day</div>
        <button onclick="window.open('https://5kable.net/#pricing')" style="width:100%;padding:12px;background:linear-gradient(135deg,#7c3aed,#5b21b6);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;margin-bottom:8px;">⭐ Upgrade to Pro</button>
        <button id="gax-teach-close-limit" style="width:100%;padding:10px;background:transparent;color:#8888aa;border:1px solid #2a2a3e;border-radius:8px;cursor:pointer;font-size:12px;">Close</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById('gax-teach-close-limit').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // Live countdown
  const timer = setInterval(() => {
    const el = document.getElementById('gax-countdown');
    if (!el) { clearInterval(timer); return; }
    el.textContent = getTimeUntilReset();
  }, 1000);
}

// NOTE: We used to inject a <script src="maps.googleapis.com/..."> directly
// into the GeoGuessr page to load the Maps JS API and build a
// StreetViewPanorama in-place. GeoGuessr's own page CSP (script-src 'self'
// ...) blocks that script from ever loading, so the panorama div just
// rendered as an empty black box. Instead, panoramas now render inside an
// <iframe src="chrome-extension://.../panorama.html?...">, a page we ship
// with the extension. Because that page's own origin is chrome-extension://,
// its CSP comes from our manifest, not GeoGuessr's, so the Maps JS API loads
// fine there. See panorama.html / panorama.js.

let _gaxSvCounter = 0;

function showTeachingPopup(locationName, state, sceneImg, refImgs, guessRefImg, guessLocationName, keyClue, bullets, tricky, distanceKm, guessRefSource) {
  const refImages = Array.isArray(refImgs) ? refImgs : (refImgs ? [refImgs] : []);
  const existing = document.getElementById('gax-teach-overlay');
  if (existing) existing.remove();

  // Every image now comes as either {pano_id, lat, lng, source:'community'}
  // (rendered as a LIVE embedded Google Street View panorama — never a
  // stored/cached copy of Google's imagery, in line with their Maps
  // Platform Terms) or {b64, source:'mapillary'} (Mapillary's openly
  // CC BY-SA licensed imagery, which is fine to serve directly).
  function renderRefMedia(ref) {
    if (!ref) return '';
    if (ref.pano_id) {
      _gaxSvCounter++;
      const iframeId = `gax-sv-${_gaxSvCounter}`;
      // IMPORTANT: this must be hosted on our own domain (5kable.net), NOT
      // packaged inside the extension. Manifest V3 extension pages
      // (chrome-extension://...) enforce a fixed script-src 'self' CSP that
      // cannot be relaxed via the manifest, so they can never load Google's
      // remote maps.googleapis.com script. A normal externally-hosted page
      // isn't bound by that restriction.
      const panoUrl = `https://5kable.net/panorama.html?pano_id=${encodeURIComponent(ref.pano_id)}&key=${encodeURIComponent(STREETVIEW_EMBED_KEY)}`;
      // "Open in Google Maps" just deep-links to Google's own site via their
      // documented pano URL scheme — no imagery of ours involved, so this
      // carries none of the caching/rehosting concerns the rest of this file
      // is built around.
      const mapsUrl = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(ref.pano_id)}`;
      return `<div class="gax-img-wrap gax-pano-wrap">
        <iframe id="${iframeId}" class="gax-main-img" src="${panoUrl}" style="width:100%;height:220px;border:0;background:#0d0d18;" loading="lazy" allow="fullscreen" allowfullscreen></iframe>
        <div class="gax-pano-controls">
          <button class="gax-pano-btn" data-gax-fullscreen="${iframeId}" title="Fullscreen">⛶</button>
          <a class="gax-pano-btn" href="${mapsUrl}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">↗</a>
        </div>
      </div>`;
    }
    if (ref.b64) {
      return `<div class="gax-img-wrap"><img class="gax-main-img" src="data:image/jpeg;base64,${ref.b64}"/></div>`;
    }
    return '';
  }

  const guessLabel = guessRefSource === 'mapillary'
    ? `📍 Near where you guessed — ${guessLocationName || 'Unknown'} (street-level photo)`
    : `📍 Where you guessed — ${guessLocationName || 'Unknown'}`;

  const overlay = document.createElement('div');
  overlay.id = 'gax-teach-overlay';
  overlay.innerHTML = `
    <div id="gax-teach-box">
      <div id="gax-teach-header">
        <div>
          <div id="gax-teach-location">${state || locationName}</div>
          <div id="gax-teach-subtitle">${locationName}</div>
        </div>
        <button id="gax-teach-close">✕</button>
      </div>
      <div id="gax-teach-body">
        ${refImages.length > 0 ? `<div class="gax-ts">✅ Correct location — ${state}</div>${renderRefMedia(refImages[0])}` : ''}
        ${guessRefImg ? `<div class="gax-ts" style="margin-top:10px">${guessLabel}</div>${renderRefMedia(guessRefImg)}` : (guessLocationName ? `<div class="gax-ts" style="margin-top:6px;color:#5a5a7a">📍 Where you guessed — ${guessLocationName} (no reference images yet)</div>` : '')}
        ${keyClue ? `<div class="gax-key-clue"><span class="gax-key-icon">🔑</span><div><div class="gax-key-label">DEAD GIVEAWAY</div><div class="gax-key-text">${keyClue}</div></div></div>` : ''}
        <div class="gax-ts">📖 What to look for</div>
        ${bullets.slice(0,3).map((b,i) => `<div class="gax-tc"><span class="gax-tc-icon">${['🔍','🌿','🛣️'][i]||'•'}</span><span class="gax-tc-text">${b}</span></div>`).join('')}
        ${tricky ? `<div class="gax-ts" style="margin-top:8px">⚠️ Easy to confuse with</div><div class="gax-trick">${tricky}</div>` : ''}
        <div id="gax-teach-chat-section">
          <div class="gax-ts">💬 Ask GeoX</div>
          <div id="gax-teach-chat-log"></div>
          <div id="gax-teach-chat-input-row">
            <input id="gax-teach-chat-input" placeholder="Ask about this location..." type="text">
            <button id="gax-teach-chat-send">↵</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('gax-teach-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) { overlay.remove(); return; }
    const fsBtn = e.target.closest('[data-gax-fullscreen]');
    if (fsBtn) {
      const iframeEl = document.getElementById(fsBtn.getAttribute('data-gax-fullscreen'));
      if (iframeEl?.requestFullscreen) {
        iframeEl.requestFullscreen().catch(err =>
          console.log('5kable: fullscreen request failed:', err.message));
      }
    }
  };

  // Auto opening message from GeoX
  const teachChatLog = document.getElementById('gax-teach-chat-log');
  if (teachChatLog) {
    const autoMsg = document.createElement('div');
    autoMsg.className = 'gax-msg gax-msg-ai';
    let openingText = '';
    if (distanceKm !== null) {
      if (distanceKm < 50)       openingText = `Only ${distanceKm}km off — you were very close. The difference here is subtle. Ask me about any clue you're unsure about.`;
      else if (distanceKm < 200) openingText = `${distanceKm}km off. These two regions look alike, which makes this a common mistake. The lesson is above — ask me anything about it.`;
      else if (distanceKm < 800) openingText = `${distanceKm}km off. Check the dead giveaway above and ask me about anything you're not sure about.`;
      else                        openingText = `${distanceKm}km off. Study the clues above — ask me anything about what you see in the photo or why this location is different from where you guessed.`;
    } else {
      openingText = `Study the clues above and ask me anything — why this location, what you should have spotted, or how to tell it apart next time.`;
    }
    autoMsg.textContent = openingText;
    teachChatLog.appendChild(autoMsg);
  };

  // Teaching chat
  const chatSend = document.getElementById('gax-teach-chat-send');
  const chatInput = document.getElementById('gax-teach-chat-input');
  const chatLog = document.getElementById('gax-teach-chat-log');

  async function sendTeachChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    chatInput.value = '';
    const userDiv = document.createElement('div');
    userDiv.className = 'gax-msg gax-msg-you';
    userDiv.textContent = msg;
    chatLog.appendChild(userDiv);

    chatSend.disabled = true;
    try {
      const teachingContext = buildTeachingContextText({ correctName: locationName, keyClue, bullets, guessLocationName, distanceKm });

      const data = await apiCall('/ai/chat', {
        token: gaxToken,
        message: msg,
        last_analysis: teachingContext
      });
      const aiDiv = document.createElement('div');
      aiDiv.className = 'gax-msg gax-msg-ai';
      aiDiv.textContent = data.reply || data.message || data.error || 'No response';
      chatLog.appendChild(aiDiv);
      chatLog.scrollTop = chatLog.scrollHeight;
    } catch(e) {
      const errDiv = document.createElement('div');
      errDiv.className = 'gax-msg gax-msg-sys';
      errDiv.textContent = 'Could not reach server';
      chatLog.appendChild(errDiv);
    }
    chatSend.disabled = false;
  }

  chatSend.onclick = sendTeachChat;
  chatInput.addEventListener('keydown', e => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') sendTeachChat();
  }, true); // capture: true so we intercept before GeoGuessr's own listeners
}

// ── Chat ───────────────────────────────────────────────────
// Silent, pre-guess-safe scene analysis for chat. Deliberately does NOT
// call triggerAnalysis() — that function shows the CONFIRMED exact
// location right in the result panel by design (that's the whole point
// of the manual Analyse button), which would spoil the answer if fired
// automatically. This instead hits a separate backend endpoint that
// never even receives coordinates, so it's structurally unable to leak
// the answer — it only describes visible clue types.
async function silentSceneClues() {
  const imageB64 = await takeScreenshot();
  if (!imageB64) return '';
  // If the player has forced a specific country map (not World mode),
  // that country isn't a secret — they picked it.
  const knownCountry = document.getElementById('gax-country-select')?.value || '';

  // Only reverse-geocode and ground with the REAL answer when a
  // country is already selected. In World mode the player wants GeoX
  // to treat the country itself as unknown too, not just the region —
  // so we deliberately withhold the true location entirely here rather
  // than risk it leaking into a "ruling things out" style answer, even
  // as an incorrect guess about the wrong country.
  let knownLocation = '';
  if (knownCountry && _gax_coords) {
    try {
      const geo = await reverseGeocode(_gax_coords.lat, _gax_coords.lng);
      if (geo) knownLocation = [geo.city, geo.state, geo.country].filter(Boolean).join(', ');
    } catch(e) {}
  }

  try {
    const data = await apiCall('/ai/scene_clues', {
      token: gaxToken, image: imageB64,
      known_country: knownCountry,
      known_location: knownLocation
    });
    return data.clues || '';
  } catch(e) {
    return '';
  }
}

// Computed fresh, not cached — coordinates may not have finished
// polling in yet at the exact moment of the round's first chat
// message, which would otherwise permanently strand that round
// without real-answer grounding. Called on every send instead.
async function getRealAnswerLine(){
  const knownCountry = document.getElementById('gax-country-select')?.value || '';
  if (!knownCountry || !_gax_coords) {
    console.log('5kable: getRealAnswerLine — skipped, knownCountry:', knownCountry, 'coords:', _gax_coords);
    return '';
  }
  try {
    const geo = await reverseGeocode(_gax_coords.lat, _gax_coords.lng);
    console.log('5kable: getRealAnswerLine — coords used:', _gax_coords.lat, _gax_coords.lng, 'round:', _gax_coords.round, 'reverseGeocode result:', geo);
    if (!geo) return '';
    const realLocation = [geo.city, geo.state, geo.country].filter(Boolean).join(', ');
    if (!realLocation) return '';
    console.log('5kable: getRealAnswerLine — real location string sent to backend:', realLocation);
    return `\nREAL ANSWER (internal use only — NEVER state this outright, but use it to keep every claim you make factually accurate; if the player names a specific region themselves, you may affirm or steer their reasoning without contradicting the truth): ${realLocation}`;
  } catch(e) {
    console.log('5kable: getRealAnswerLine — error:', e.message);
    return '';
  }
}

async function sendChatMessage(msg, btnEl) {
  if (!msg) return;
  chatAppend('you', msg);

  if (!gaxToken) { chatAppend('sys', 'Please sign in first.'); return; }

  if (btnEl) btnEl.disabled = true;

  // Safety net against stale context: the round-transition handler
  // clears lastAnalysisText for a new round, but then immediately
  // re-populates it with the round that just ended (for post-round
  // follow-up questions) — so by the time chat actually gets used,
  // lastAnalysisText can be non-empty but describing an OLDER round
  // than the one currently on screen. Checking the stamped round here,
  // right before use, catches that regardless of exactly when/whether
  // the clearing itself ran.
  const currentRound = _gax_coords?.round || 0;
  if (lastAnalysisText && currentRound && lastAnalysisRound !== currentRound) {
    lastAnalysisText = '';
    lastAnalysisRound = 0;
  }

  // If there's no context yet for the current scene, silently look at
  // it first — clues only, never the actual answer — so asking a
  // question is enough without a separate manual step. This does NOT
  // reveal your exact location; only clicking Analyse yourself does that.
  if (!lastAnalysisText && isInRound()) {
    const knownCountry = document.getElementById('gax-country-select')?.value || '';
    const clues = await silentSceneClues();
    if (clues) {
      lastAnalysisText = knownCountry
        ? `MAP COUNTRY (already known to the player, not secret): ${knownCountry}\nVISIBLE SCENE CLUES (specific region within ${knownCountry} not to be stated outright — discuss clues and country-level knowledge only): ${clues}`
        : `VISIBLE SCENE CLUES (no location known/revealed — describe and discuss clues only): ${clues}`;
      lastAnalysisRound = currentRound;
      chrome.storage.local.set({ gax_last_analysis: lastAnalysisText });
    }
  }

  // Real-answer grounding is recomputed fresh on every single message
  // (cheap — just a reverse-geocode, not another AI call) rather than
  // baked once into lastAnalysisText, so a coords-polling hiccup on
  // your very first question of the round can't strand the rest of
  // the conversation without it.
  const realAnswerLine = await getRealAnswerLine();

  try {
    const data = await apiCall('/ai/chat', {
      token: gaxToken,
      message: msg,
      last_analysis: (lastAnalysisText.substring(0, 500) + realAnswerLine)
    });
    if (data.code === 'pro') {
      chatAppend('sys', '⭐ GeoX chat is a Pro feature. Upgrade for unlimited access.');
    } else if (data.reply) {
      chatAppend('ai', data.reply);
    } else {
      chatAppend('sys', data.error || 'No response');
    }
  } catch(e) {
    chatAppend('sys', 'Could not reach server.');
  }
  if (btnEl) btnEl.disabled = false;
}

async function sendChat() {
  const input = document.getElementById('gax-chat-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  await sendChatMessage(msg, document.getElementById('gax-chat-send'));
}

async function sendChatModal() {
  const input = document.getElementById('gax-chat-input-modal');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  await sendChatMessage(msg, document.getElementById('gax-chat-send-modal'));
}

// ── Popup chat (bigger window, same conversation/context as the sidebar) ──
function openGeoXChatModal() {
  const existing = document.getElementById('gax-chat-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gax-chat-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <style>
      #gax-chat-log-modal { display:flex; flex-direction:column; }
      #gax-chat-log-modal .gax-modal-msg {
        max-width:80%; padding:9px 13px; border-radius:12px; font-size:13px; line-height:1.5;
        word-wrap:break-word; white-space:pre-wrap;
        -webkit-text-fill-color:initial; background-clip:initial; -webkit-background-clip:initial;
      }
      #gax-chat-log-modal .gax-modal-msg-you { align-self:flex-end; background:#00c9a7; color:#080810 !important; font-weight:600; }
      #gax-chat-log-modal .gax-modal-msg-ai  { align-self:flex-start; background:#1a1a2e; color:#e0e0f0 !important; border:1px solid #2a2a3e; }
      #gax-chat-log-modal .gax-modal-msg-sys { align-self:center; color:#8888aa !important; font-size:11px; font-style:italic; }
    </style>
    <div id="gax-chat-modal" style="background:#0d0d18;border:1px solid #2a2a3e;border-radius:16px;width:min(520px,92vw);height:min(640px,85vh);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #1e1e2e;flex-shrink:0;">
        <div style="font-weight:800;color:#e0e0f0;font-size:14px;display:flex;align-items:center;gap:8px;">💬 GeoX Chat <span id="gax-chat-mode-badge-modal" style="background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3);color:#a78bfa;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;">World</span></div>
        <button id="gax-chat-modal-close" style="background:none;border:none;color:#8888aa;font-size:20px;cursor:pointer;line-height:1;padding:4px;">✕</button>
      </div>
      <div id="gax-chat-log-modal" style="flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:8px;"></div>
      <div style="display:flex;gap:8px;padding:14px 16px;border-top:1px solid #1e1e2e;flex-shrink:0;">
        <input id="gax-chat-input-modal" placeholder="Ask GeoX..." type="text" style="flex:1;background:#1a1a2e;border:1px solid #2a2a3e;color:#e0e0f0;padding:10px 14px;border-radius:10px;font-size:13px;outline:none;">
        <button id="gax-chat-send-modal" style="background:#00c9a7;border:none;color:#080810;padding:10px 16px;border-radius:10px;font-weight:800;cursor:pointer;flex-shrink:0;">↵</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  updateChatModeBadge();

  // Replay existing conversation into the modal so it picks up right
  // where the sidebar chat left off, not starting empty.
  const modalLog = document.getElementById('gax-chat-log-modal');
  gaxChatHistory.forEach(m => {
    const div = document.createElement('div');
    div.className = 'gax-modal-msg gax-modal-msg-' + m.sender;
    div.textContent = m.text;
    modalLog.appendChild(div);
  });
  modalLog.scrollTop = modalLog.scrollHeight;

  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.getElementById('gax-chat-modal-close').onclick = closeModal;

  document.getElementById('gax-chat-send-modal').onclick = sendChatModal;
  const modalInput = document.getElementById('gax-chat-input-modal');
  modalInput.addEventListener('keydown', e => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') sendChatModal();
  }, true); // capture: true so we intercept before GeoGuessr's own listeners
  modalInput.focus();
}

// ── Start ──────────────────────────────────────────────────
// Registered immediately, synchronously, at the top level — before the
// DOM-ready gate below, and before GeoGuessr's own page scripts get a
// chance to run at all now that this script loads at document_start.
// window.addEventListener doesn't need the DOM to exist yet, so there's
// no reason to defer this inside init() like everything else.
setupGlobalInputGuard();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}