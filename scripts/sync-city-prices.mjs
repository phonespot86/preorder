import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'prices.json');
const CURRENT_CARRIERS = ['SKT', 'KT', 'LG', '알뜰폰'];
const DESTINATIONS = ['SKT', 'KT', 'LG'];
const MODEL_RULES = {
  flip8: { name: '갤럭시 Z 플립 8', modelPrefix: 'SM-F776' },
  fold8: { name: '갤럭시 Z 폴드 8', modelPrefix: 'SM-F971' },
  ultra: { name: '갤럭시 Z 폴드 8 울트라', modelPrefix: 'SM-F976' }
};

function request({ method = 'GET', pathname, body = '', cookie = '' }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'citymarket.co.kr',
      port: 443,
      method,
      path: pathname,
      headers: {
        'User-Agent': 'phonespot-preorder-price-sync/1.0',
        'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === 'POST' ? {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'Referer': 'https://citymarket.co.kr/pb',
          'X-Requested-With': 'XMLHttpRequest'
        } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function normalizeCarrier(value) {
  return value === 'LG' ? 'LG U+' : value;
}

function findModel(list, rule) {
  for (const phone of list || []) {
    const capacity = (phone.capacities || []).find((item) => {
      const modelName = Object.values(item.deals || {})[0]?.modelName || '';
      return modelName.startsWith(rule.modelPrefix) && !modelName.includes('_512G');
    });
    if (capacity) return { phone, capacity };
  }
  return null;
}

function buildApplyUrl(phone, capacity, deal, currentCarrier) {
  const imageName = capacity.modelFileName || phone.modelFileName || '';
  const params = new URLSearchParams({
    uri: 'pb',
    fee: String(deal.fee || ''),
    route: deal.sellChannel || '폰스팟본점',
    sellChannel: deal.sellChannel || '폰스팟본점',
    agency: deal.agency || '',
    section: deal.section || '',
    model: capacity.petName || phone.base || '',
    modelBase: phone.base || '',
    capacity: capacity.cap || '',
    modelName: deal.modelName || '',
    price: String(deal.price || capacity.price || ''),
    supply: String(deal.supply || ''),
    addSupply: String(deal.addSupply || ''),
    discount: String(deal.specialDiscount || ''),
    purchasePrice: String(deal.purchasePrice ?? ''),
    plan: deal.planName || '',
    planName: deal.planName || '',
    imgSrc: imageName ? `https://qwer123.co.kr/image/${imageName}` : '',
    openingType: deal.openingType || (deal.company === currentCarrier ? '기기변경' : '번호이동'),
    company: deal.company || '',
    historyCompany: currentCarrier,
    saleInfo: '공시지원금',
    producer: phone.producer || '',
    series_name: deal.series_name || '',
    group_name: deal.group_name || ''
  });
  return `https://citymarket.co.kr/applyInquiry?${params.toString()}`;
}

function normalizeState(list, currentCarrier) {
  const models = {};
  for (const [key, rule] of Object.entries(MODEL_RULES)) {
    const found = findModel(list, rule);
    const phone = found?.phone;
    const capacity = found?.capacity;
    const retailPrice = Number(capacity?.price || 0);
    const offers = DESTINATIONS.map((destination) => {
      const deal = capacity?.deals?.[destination];
      if (!deal) return {
        carrier: normalizeCarrier(destination),
        activationType: destination === currentCarrier ? '기기변경' : '번호이동',
        status: '혜택 준비중'
      };
      const purchasePrice = Number(deal.purchasePrice);
      return {
        carrier: normalizeCarrier(destination),
        activationType: destination === currentCarrier ? '기기변경' : '번호이동',
        purchasePrice,
        retailPrice: Number(deal.price || retailPrice),
        discountRate: retailPrice > 0 ? Math.round((retailPrice - purchasePrice) / retailPrice * 100) : 0,
        planName: deal.planName || '',
        fee: Number(deal.fee || 0),
        applyUrl: buildApplyUrl(phone, capacity, deal, currentCarrier),
        status: '판매중'
      };
    });
    models[key] = { name: rule.name, retailPrice, offers };
  }
  return { models };
}

const landing = await request({ pathname: '/pb' });
if (landing.status !== 200) throw new Error(`시티마켓 접속 실패: HTTP ${landing.status}`);
const cookie = (landing.headers['set-cookie'] || []).map((value) => value.split(';')[0]).join('; ');
const states = {};

for (const currentCarrier of CURRENT_CARRIERS) {
  const body = new URLSearchParams({
    company: currentCarrier,
    saleInfo: '공시지원금',
    producer: '',
    uri: 'pb',
    sellChannel: '폰스팟본점'
  }).toString();
  const response = await request({ method: 'POST', pathname: '/manage/inquiryGrid', body, cookie });
  if (response.status !== 200) throw new Error(`${currentCarrier} 가격 조회 실패: HTTP ${response.status}`);
  const payload = JSON.parse(response.text);
  states[currentCarrier] = normalizeState(payload.list, currentCarrier);
}

let previous = null;
try { previous = JSON.parse(await fs.readFile(OUTPUT, 'utf8')); } catch {}
const comparable = JSON.stringify(states);
const previousComparable = JSON.stringify(previous?.states || null);
const checkedAt = new Date().toISOString();
const result = {
  source: 'https://citymarket.co.kr/pb',
  checkedAt,
  updatedAt: comparable === previousComparable && previous?.updatedAt ? previous.updatedAt : checkedAt,
  states
};

await fs.writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
if (comparable !== previousComparable || !previous) {
  console.log(`가격 변동 반영: ${result.updatedAt}`);
} else {
  console.log(`가격 확인 완료: ${result.checkedAt}`);
}
