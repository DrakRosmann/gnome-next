import GLib from 'gi://GLib';

const DEFAULT_HOUR = 9;

/* Natural language times, in Portuguese and English: "amanhã 9h",
 * "sexta às 14:30", "em 20 min", "dia 5 de manhã", "tomorrow 9am",
 * "in 2 hours", "monday at noon", "25/12"... */

const WEEKDAYS = {
    domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const PERIODS = {
    manha: 9, morning: 9,
    tarde: 15, afternoon: 15,
    noite: 20, evening: 20, night: 20,
};

const DAY_PREFIX = '(?:(?:para|pra|for|on|na|no|nesta|neste|nessa|nesse|this|next|proxima|proximo)\\s+)*';
const TIME_PREFIX = '(?:(?:as|at|ate|by|@)\\s+)?';

function unitSeconds(unit) {
    if (unit.startsWith('s') || unit.startsWith('w'))
        return 7 * 86400;
    if (unit.startsWith('d'))
        return 86400;
    if (unit.startsWith('h'))
        return 3600;
    return 60;
}

function amount(word) {
    if (/^\d+$/.test(word))
        return parseInt(word);
    return /^(meia|half)/.test(word) ? 0.5 : 1;
}

// Lower case without accents, keeping every index of the original text
function fold(text) {
    return [...text].map(c => {
        const f = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        return f.length === c.length ? f : c;
    }).join('');
}

function validTime(hour, minute) {
    return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

export function parseReminder(input, now = GLib.DateTime.new_now_local()) {
    let folded = fold(input);
    const spans = [];
    // Finds `pattern`; when `handle` accepts the match, removes it from the text
    const take = (pattern, handle) => {
        const match = new RegExp(pattern).exec(folded);
        if (!match || handle(match) === false)
            return false;
        spans.push([match.index, match.index + match[0].length]);
        folded = folded.slice(0, match.index) + ' '.repeat(match[0].length) +
            folded.slice(match.index + match[0].length);
        return true;
    };

    let relative = 0;
    let days = null, weekday = null, date = null, monthDay = null;
    let hour = null, minute = 0, period = null;

    take(`\\b(?:em|daqui a|daqui|dentro de|in|within)\\s+(\\d+|uma?|an?|meia|half an?)\\s*(minutos?|mins?|m|horas?|hours?|hrs?|h|dias?|days?|semanas?|weeks?)\\b`,
        m => {
            if (amount(m[1]) === 0.5 && !m[2].startsWith('h'))
                return false;
            relative = Math.round(amount(m[1]) * unitSeconds(m[2]));
            return relative > 0;
        });

    if (!relative) {
        take(`\\b${DAY_PREFIX}(?:depois de amanha|(?:the )?day after tomorrow)\\b`, () => (days = 2)) ||
        take(`\\b${DAY_PREFIX}(?:amanha|tomorrow)\\b`, () => (days = 1)) ||
        take(`\\b${DAY_PREFIX}(hoje|today|tonight)\\b`, m => {
            days = 0;
            if (m[1] === 'tonight')
                period = 'night';
        }) ||
        take(`\\b${DAY_PREFIX}(${Object.keys(WEEKDAYS).join('|')})(?:-feira| feira)?\\b`,
            m => (weekday = WEEKDAYS[m[1]])) ||
        take('\\b(?:(?:em|no dia|dia|on|para|pra)\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?\\b(?!\\s+de\\s+(?!manha|tarde|noite))', m => {
            let [day, month] = [parseInt(m[1]), parseInt(m[2])];
            // Month first in the US
            if (GLib.get_language_names()[0].startsWith('en_US'))
                [day, month] = [month, day];
            if (day < 1 || day > 31 || month < 1 || month > 12)
                return false;
            const year = m[3] ? parseInt(m[3]) + (m[3].length === 2 ? 2000 : 0) : null;
            date = {day, month, year};
            return true;
        }) ||
        take('\\b(?:no\\s+)?dia\\s+(\\d{1,2})\\b(?!\\s*[/:h])', m => {
            monthDay = parseInt(m[1]);
            return monthDay >= 1 && monthDay <= 31;
        });

        take(`\\b${TIME_PREFIX}(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b`, m => {
            const h = parseInt(m[1]);
            const min = m[2] ? parseInt(m[2]) : 0;
            if (h < 1 || h > 12 || !validTime(h, min))
                return false;
            hour = h % 12 + (m[3] === 'pm' ? 12 : 0);
            minute = min;
            return true;
        }) ||
        take(`\\b${TIME_PREFIX}(\\d{1,2})(?::(\\d{2})|h(\\d{2})?(?:min)?)\\b`, m => {
            const h = parseInt(m[1]);
            const min = parseInt(m[2] ?? m[3] ?? '0');
            if (!validTime(h, min))
                return false;
            [hour, minute] = [h, min];
            return true;
        }) ||
        take('\\b(?:(?:ao|as|at)\\s+)?(meio-dia|meio dia|noon|midday|meia-noite|meia noite|midnight)\\b', m => {
            hour = /noon|midday|meio/.test(m[1]) ? 12 : 0;
            minute = 0;
        }) ||
        take('\\b(?:as|at)\\s+(\\d{1,2})\\b(?![/:])', m => {
            hour = parseInt(m[1]);
            return validTime(hour, 0);
        });

        // "de manhã", "à tarde", "9 da noite", "in the morning", "this evening"
        take(`\\b(?:de|da|pela|a|in the|this)\\s+(${Object.keys(PERIODS).join('|')})\\b`, m => {
            period = m[1];
        });
    }

    let due = 0;
    if (relative) {
        due = now.to_unix() + relative;
    } else if (days !== null || weekday !== null || date || monthDay || hour !== null || period) {
        if (period && hour === null)
            hour = PERIODS[period];
        else if (period && hour < 12 && PERIODS[period] >= 15)
            hour += 12;
        hour ??= DEFAULT_HOUR;
        const at = (y, mo, d) => GLib.DateTime.new_local(y, mo, d, hour, minute, 0);

        let when = null;
        if (date) {
            const year = date.year ?? now.get_year();
            when = at(year, date.month, date.day);
            if (when && !date.year && when.to_unix() < now.to_unix())
                when = at(year + 1, date.month, date.day);
        } else if (monthDay) {
            when = at(now.get_year(), now.get_month(), monthDay);
            if (!when || when.to_unix() < now.to_unix()) {
                const next = now.add_months(1);
                when = at(next.get_year(), next.get_month(), monthDay);
            }
        } else {
            let offset = days ?? 0;
            if (weekday !== null)
                offset = (weekday - now.get_day_of_week() % 7 + 7) % 7;
            const day = now.add_days(offset);
            when = at(day.get_year(), day.get_month(), day.get_day_of_month());
            // A time or weekday that already passed means the next one
            if (when && when.to_unix() <= now.to_unix() && days === null)
                when = when.add_days(weekday !== null ? 7 : 1);
        }
        due = when?.to_unix() ?? 0;
    }

    let text = input;
    if (due) {
        for (const [start, end] of spans.sort((a, b) => b[0] - a[0]))
            text = text.slice(0, start) + text.slice(end);
        text = text.replace(/\s{2,}/g, ' ').replace(/^[\s,;:.–—-]+|[\s,;:–—-]+$/g, '');
    }
    return {text: text.trim() || input.trim(), due};
}
