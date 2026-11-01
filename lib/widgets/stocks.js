import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Widget, closeCalendar, label, placeholder, vbox} from './base.js';
import {Sparkline} from './drawing.js';

const LIMITS = {small: 1, medium: 3, large: 7};
const REFRESH = 5 * 60; // seconds
const RETRY = 60; // seconds before trying again after a failure
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?range=1d&interval=15m';
const QUOTE_URL = 'https://finance.yahoo.com/quote/%s';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Used while the stock-symbols setting was never changed
const DEFAULT_SYMBOLS = {
    BR: ['^BVSP', 'PETR4.SA', 'VALE3.SA', 'USDBRL=X', 'BTC-USD'],
    PT: ['PSI20.LS', 'EURUSD=X', 'BTC-USD'],
    '': ['^GSPC', '^IXIC', 'AAPL', 'MSFT', 'BTC-USD'],
};

export function stockSymbols(settings) {
    if (settings.get_user_value('stock-symbols'))
        return settings.get_strv('stock-symbols');
    const region = GLib.get_language_names()[0].match(/^[a-z]+_([A-Z]+)/)?.[1] ?? '';
    return DEFAULT_SYMBOLS[region] ?? DEFAULT_SYMBOLS[''];
}

let session = null;
const quotes = new Map(); // symbol -> {quote, fetchedAt, failedAt, pending}

export function clearQuotes() {
    session?.abort();
    session = null;
    quotes.clear();
}

async function fetchQuote(symbol) {
    session ??= new Soup.Session({user_agent: 'Mozilla/5.0 (X11; Linux x86_64) GNOME-Next', timeout: 15});
    const message = Soup.Message.new('GET', CHART_URL.format(encodeURIComponent(symbol)));
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK)
        throw new Error(`HTTP ${message.get_status()}`);
    const result = JSON.parse(new TextDecoder().decode(bytes.toArray())).chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice)
        throw new Error('No quote');
    const previous = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(v => typeof v === 'number');
    return {
        symbol,
        type: meta.instrumentType ?? '',
        // The current session, or the last one while closed
        session: meta.currentTradingPeriod?.regular ?? null,
        fetchedAt: GLib.DateTime.new_now_local().to_unix(),
        name: (meta.shortName ?? meta.longName ?? symbol).replace(/\s+/g, ' ').trim(),
        price: meta.regularMarketPrice,
        change: meta.regularMarketPrice - previous,
        percent: previous ? (meta.regularMarketPrice - previous) / previous * 100 : 0,
        closes: closes.length > 1 ? closes : [previous, meta.regularMarketPrice],
    };
}

// Cached for a few minutes and shared by every copy of the widget. When
// offline, the last quote comes back marked `stale`.
function quote(symbol) {
    const now = GLib.get_monotonic_time() / 1e6;
    let entry = quotes.get(symbol);
    if (entry?.pending)
        return entry.pending;
    if (entry?.quote && now - entry.fetchedAt < REFRESH)
        return Promise.resolve(entry.quote);
    const stale = () => entry.quote
        ? Promise.resolve({...entry.quote, stale: true})
        : Promise.reject(new Error('Quote unavailable'));
    if (entry?.failedAt && now - entry.failedAt < RETRY)
        return stale();

    entry ??= {};
    quotes.set(symbol, entry);
    entry.pending = fetchQuote(symbol)
        .then(q => {
            entry.quote = q;
            entry.fetchedAt = now;
            entry.failedAt = 0;
            return q;
        }, e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                entry.failedAt = now;
            return stale();
        })
        .finally(() => (entry.pending = null));
    return entry.pending;
}

// Cryptocurrencies trade all the time; the rest between the session times
function marketOpen(q) {
    if (q.type === 'CRYPTOCURRENCY' || !q.session)
        return true;
    const now = GLib.DateTime.new_now_local().to_unix();
    return now >= q.session.start && now < q.session.end;
}

function clockTime(unix) {
    return formatTime(GLib.DateTime.new_from_unix_local(unix), {timeOnly: true});
}

// Shown under the prices: offline, closed, or (large) when they were updated
function statusOf(loaded, large) {
    const stale = loaded.filter(q => q.stale);
    if (stale.length > 0) {
        /* Translators: shown with the time of the prices that are shown */
        return {icon: 'network-offline-symbolic', text: _('Offline · %s').format(
            clockTime(Math.min(...stale.map(q => q.fetchedAt))))};
    }
    const markets = loaded.filter(q => q.type !== 'CRYPTOCURRENCY');
    if (markets.length > 0 && !markets.some(marketOpen))
        return {icon: 'weather-clear-night-symbolic', text: _('Market closed')};
    if (large) {
        return {icon: null, text: _('Updated at %s').format(
            clockTime(Math.max(...loaded.map(q => q.fetchedAt))))};
    }
    return null;
}

function formatNumber(value) {
    return value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function formatPercent(value) {
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    return `${sign}${formatNumber(Math.abs(value))}%`;
}

function displaySymbol(symbol) {
    return symbol.replace(/^\^/, '').replace(/\.SA$/, '').replace(/=X$/, '');
}

function openQuote(symbol) {
    closeCalendar();
    Gio.AppInfo.launch_default_for_uri(QUOTE_URL.format(encodeURIComponent(symbol)),
        global.create_app_launch_context(0, -1));
}

// Prices from Yahoo Finance: the first symbol in the small size, a list with
// today's chart for each in the others
export const StocksWidget = GObject.registerClass(
class GnStocksWidget extends Widget {
    constructor(size, {settings}) {
        super(size, {accessible_name: _('Stocks')});
        this.add_style_class_name('gn-stocks-widget');
        this._settings = settings;
        this._generation = 0;

        const box = vbox({x_expand: true, y_expand: true});
        this.child = box;
        this._list = vbox({style_class: 'gn-stocks-list', x_expand: true, y_expand: true});
        box.add_child(this._list);
        this._placeholder = placeholder('network-offline-symbolic', _('Stock prices are unavailable'));
        this._placeholder.visible = false;
        box.add_child(this._placeholder);

        this._status = new St.BoxLayout({style_class: 'gn-stocks-status', visible: false});
        this._statusIcon = new St.Icon({style_class: 'gn-stocks-status-icon'});
        this._status.add_child(this._statusIcon);
        this._statusLabel = label('gn-stocks-status-text', {y_align: Clutter.ActorAlign.CENTER});
        this._status.add_child(this._statusLabel);
        box.add_child(this._status);

        settings.connectObject('changed::stock-symbols', () => this._refresh(), this);
        this.connect('destroy', () => {
            this._generation++;
            settings.disconnectObject(this);
        });
        this.poll(REFRESH, () => this._refresh());
    }

    _symbols() {
        return stockSymbols(this._settings).slice(0, LIMITS[this.widgetSize]);
    }

    async _refresh() {
        const generation = ++this._generation;
        const symbols = this._symbols();
        this.empty = symbols.length === 0;
        if (this.empty)
            return;

        const results = await Promise.allSettled(symbols.map(s => quote(s)));
        // Destroyed, or a newer refresh started meanwhile
        if (generation !== this._generation)
            return;

        let loaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        if (this.small)
            loaded = loaded.slice(0, 1);
        this._placeholder.visible = loaded.length === 0;
        this._list.visible = loaded.length > 0;

        const status = loaded.length > 0 ? statusOf(loaded, this.large) : null;
        this._status.visible = Boolean(status);
        if (status) {
            this._statusIcon.visible = Boolean(status.icon);
            if (status.icon)
                this._statusIcon.icon_name = status.icon;
            this._statusLabel.text = status.text;
        }
        // The status line takes the place of the third row
        if (status && this.widgetSize === 'medium')
            loaded = loaded.slice(0, LIMITS.medium - 1);

        this._list.destroy_all_children();
        if (this.small && loaded[0])
            this._list.add_child(this._big(loaded[0]));
        else
            loaded.forEach(q => this._list.add_child(this._row(q)));
    }

    _trend(q) {
        return q.change >= 0 ? 'up' : 'down';
    }

    _chart(q) {
        const chart = new Sparkline({style_class: `gn-sparkline gn-stock-chart ${this._trend(q)}`});
        chart.setValues(q.closes);
        return chart;
    }

    _pill(q) {
        return new St.Label({
            style_class: `gn-stock-change ${this._trend(q)}`,
            text: formatPercent(q.percent),
            x_align: Clutter.ActorAlign.END,
        });
    }

    _big(q) {
        const box = vbox({style_class: 'gn-stock-big', x_expand: true, y_expand: true});
        // The change goes up with the symbol so that big prices fit
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(label('gn-stock-symbol', {text: displaySymbol(q.symbol), x_expand: true}));
        const pill = this._pill(q);
        pill.y_align = Clutter.ActorAlign.CENTER;
        top.add_child(pill);
        box.add_child(top);
        box.add_child(label('gn-widget-dim gn-stock-name', {text: q.name}));
        const chart = this._chart(q);
        chart.y_expand = true;
        box.add_child(chart);
        box.add_child(label('gn-stock-price', {text: formatNumber(q.price)}));
        return box;
    }

    _row(q) {
        const row = new St.Button({style_class: 'gn-stock-row', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({x_expand: true});
        row.child = box;
        const names = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        names.add_child(label('gn-stock-symbol', {text: displaySymbol(q.symbol)}));
        names.add_child(label('gn-widget-dim gn-stock-name', {text: q.name}));
        box.add_child(names);
        const chart = this._chart(q);
        chart.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(chart);
        const values = vbox({style_class: 'gn-stock-values', y_align: Clutter.ActorAlign.CENTER});
        values.add_child(label('gn-stock-price', {text: formatNumber(q.price), x_align: Clutter.ActorAlign.END}));
        values.add_child(this._pill(q));
        box.add_child(values);
        row.connect('clicked', () => {
            openQuote(q.symbol);
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    activate() {
        const [first] = this._symbols();
        if (first)
            openQuote(first);
    }
});
