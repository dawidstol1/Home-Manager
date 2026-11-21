// Panel „Zasoby domowe” w menu Home Assistant: cała aplikacja w ramce, przez Home Assistant
// (działa w domu i poza domem – tam, gdzie działa HA, także w aplikacji na telefonie).
class HomeManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: flex; flex-direction: column; height: 100%; background: var(--primary-background-color); }
        .bar { display: none; align-items: center; gap: 4px; height: 56px; padding: 0 4px; flex: none;
          background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff);
          border-bottom: var(--app-header-border-bottom, none); font-size: 20px; }
        :host([narrow]) .bar { display: flex; }
        .title { margin-left: 8px; }
        iframe { flex: 1; width: 100%; border: 0; display: block; }
        .msg { padding: 24px; font-family: var(--paper-font-body1_-_font-family, sans-serif); color: var(--primary-text-color); }
      </style>
      <div class="bar"><span class="menu"></span><span class="title">Zasoby domowe</span></div>
      <div class="msg">Łączę z aplikacją Zasoby domowe…</div>`;
  }

  set hass(hass) {
    this._hass = hass;
    const menu = this.shadowRoot.querySelector('ha-menu-button');
    if (menu) menu.hass = hass;
    this._maybeStart();
  }

  set narrow(narrow) {
    this.toggleAttribute('narrow', Boolean(narrow));
    const menu = this.shadowRoot.querySelector('ha-menu-button');
    if (menu) menu.narrow = narrow;
  }

  set panel(panel) {
    this._panel = panel;
    this._maybeStart();
  }

  connectedCallback() {
    if (!this.shadowRoot.querySelector('ha-menu-button') && customElements.get('ha-menu-button')) {
      const menu = document.createElement('ha-menu-button');
      menu.hass = this._hass;
      menu.narrow = this.hasAttribute('narrow');
      this.shadowRoot.querySelector('.menu').appendChild(menu);
    }
    // Odnawianie sesji panelu co godzinę, gdy panel jest otwarty.
    this._timer = setInterval(() => this._session().catch(() => {}), 3600 * 1000);
    this._maybeStart();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  async _session() {
    const r = await this._hass.callWS({ type: 'home_manager/panel', entry_id: this._panel.config.entry_id });
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${r.cookie}=${r.token}; path=${r.path}; max-age=${r.max_age}; SameSite=Strict${secure}`;
    return r;
  }

  async _maybeStart() {
    if (this._started || !this._hass || !this._panel || !this.isConnected) return;
    this._started = true;
    const msg = this.shadowRoot.querySelector('.msg');
    try {
      const r = await this._session();
      const frame = document.createElement('iframe');
      frame.title = 'Zasoby domowe';
      frame.allow = 'camera; clipboard-write';
      frame.src = r.path;
      msg.replaceWith(frame);
    } catch (err) {
      this._started = false;
      msg.textContent = `Nie udało się otworzyć aplikacji: ${err?.message || err}`;
    }
  }
}

customElements.define('home-manager-panel', HomeManagerPanel);
