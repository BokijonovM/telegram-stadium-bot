import dayjsBase from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';


dayjsBase.extend(utc);
dayjsBase.extend(tz);


const TZ = process.env.TZ || 'Asia/Tashkent';
export const dayjs = (d) => d ? dayjsBase(d).tz(TZ) : dayjsBase().tz(TZ);


export const OPEN_HOUR = Number(process.env.OPEN_HOUR || 9);
export const CLOSE_HOUR = Number(process.env.CLOSE_HOUR || 23);


export function hoursList() {
    const len = Math.max(0, CLOSE_HOUR - OPEN_HOUR);
    return Array.from({
        length: len
    }, (_, i) => `${String(OPEN_HOUR + i).padStart(2,'0')}:00`);
}


export function formatDate(d) {
    return dayjs(d).format('YYYY-MM-DD');
}
export function parseDateTime(date, hour) {
    return dayjs(`${date} ${hour}`, 'YYYY-MM-DD HH:mm');
}