// =====================================================================
// CONFIGURATION — a completer avant de deployer/heberger ce site
// =====================================================================
const CONFIG = {
  RPC_URL: "https://json-rpc.evm.testnet.iota.cafe",
  CONTRACT_ADDRESS_MULTI: "0x693319152044B301D33c594952F006E60d4bfA3A",
};

const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://ipfs.io/ipfs",
  "https://dweb.link/ipfs",
  "https://cloudflare-ipfs.com/ipfs"
];

const ABI = [
  "function etapeActuelle(string) view returns (uint8)",
  "function consulterLot(string) view returns (uint8 etape, string resultatDetectionIA, uint8 pourcentagePorcEstime, bytes32 empreinteCryptographique, string cidIPFS, address acteurProduction, address acteurAbattage, address acteurProcessing, address acteurRetailing, uint256 tsProduction, uint256 tsAbattage, uint256 tsProcessing, uint256 tsRetailing)",
  "function verifierIntegrite(string, bytes32) view returns (bool)",
  "function nombreEvenementsHistorique(string) view returns (uint256)",
  "function evenementHistorique(string, uint256) view returns (uint8 etape, address acteur, string cidIPFS, uint256 timestamp)"
];

const ETAPE_LABEL = {
  Production: "Production",
  Abattage: "Abattage",
  Processing: "Processing",
  Retailing: "Retailing"
};

const $ = (id) => document.getElementById(id);
let provider = null, contract = null;

function getProvider(){
  if(!provider) provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  return provider;
}
function getContract(){
  if(!contract) contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS_MULTI, ABI, getProvider());
  return contract;
}

async function fetchFromIPFS(cid){
  if(String(cid).startsWith("bafklocal")){
    throw new Error("Ce lot a été soumis en mode local (IPFS_MODE=local) : son contenu n'est pas publié sur le réseau IPFS public.");
  }
  const tentatives = IPFS_GATEWAYS.map(async (base) => {
    console.log(`[IPFS] tentative : ${base}/${cid}`);
    const res = await fetch(`${base}/${cid}`, { signal: AbortSignal.timeout(3000) });
    if(!res.ok){ throw new Error(`HTTP ${res.status} (${base})`); }
    console.log(`[IPFS] succès via ${base}`);
    return await res.json();
  });
  try{
    // Promise.any : la premiere gateway qui repond avec succes suffit,
    // on n'attend pas les 4 sequentiellement (gain : minutes -> secondes).
    return await Promise.any(tentatives);
  }catch(aggregateError){
    const messages = (aggregateError.errors || [aggregateError]).map(e => e.message).join(' | ');
    throw new Error(messages || "Impossible de joindre une gateway IPFS.");
  }
}

async function recalculerHash(donnees){
  const dateIso = String(donnees['date_transformation']).trim() + 'T00:00:00';
  const payload = `${donnees['lot_id']}|${donnees['animal_id']}|${donnees['resultat_detection_ia']}|${donnees['pourcentage_porc_estime']}|${dateIso}`;
  const enc = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatDate(tsSecondsBigInt){
  const ts = Number(tsSecondsBigInt);
  if(!ts) return null;
  return new Date(ts * 1000).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

function renderSeal(state){
  const colors = { ok: '#0F7A5A', fraud: '#C1352A', missing: '#8A93A6' };
  const labels = { ok: 'INTÈGRE', fraud: 'ALTÉRÉ', missing: 'EN ATTENTE' };
  const c = colors[state], label = labels[state];
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const x1 = 60 + Math.cos(a) * 52, y1 = 60 + Math.sin(a) * 52;
    const x2 = 60 + Math.cos(a) * 46, y2 = 60 + Math.sin(a) * 46;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="2"/>`;
  }).join('');
  const icon = state === 'ok'
    ? `<path d="M42 61 L54 73 L80 47" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
    : state === 'fraud'
    ? `<path d="M45 45 L75 75 M75 45 L45 75" stroke="${c}" stroke-width="6" stroke-linecap="round"/>`
    : `<circle cx="60" cy="60" r="4" fill="${c}"/>`;
  $('sealSvg').innerHTML = `
    <circle cx="60" cy="60" r="56" fill="none" stroke="${c}" stroke-width="2.5"/>
    <circle cx="60" cy="60" r="40" fill="none" stroke="${c}" stroke-width="1.2"/>
    ${ticks}${icon}
    <text x="60" y="98" text-anchor="middle" font-family="-apple-system, Segoe UI, Arial, sans-serif" font-size="10" font-weight="bold" fill="${c}" letter-spacing="1">${label}</text>`;
}

// Champs a afficher par etape (nom de colonne CSV -> libelle affiche), dans
// l'ordre. Seuls les champs presents dans le JSON recupere sur IPFS sont
// affiches -- pas d'adresse de wallet, non pertinente pour un consommateur.
const CHAMPS_AFFICHES = {
  Production: [
    ['race', 'Race'],
    ['eleveur_nom', 'Éleveur'],
    ['eleveur_localisation', 'Localisation'],
    ['poids_vivant_kg', 'Poids vif', ' kg'],
  ],
  Abattage: [
    ['abattoir_nom', 'Abattoir'],
    ['abattoir_localisation', 'Localisation'],
    ['abattoir_certifie_halal', 'Certifié halal'],
    ['poids_carcasse_kg', 'Poids carcasse', ' kg'],
  ],
  Processing: [
    ['usine_transformation', 'Usine de transformation'],
    ['type_transformation', 'Type de transformation'],
    ['poids_transforme_kg', 'Poids transformé', ' kg'],
  ],
  Retailing: [
    ['distributeur_nom', 'Distributeur'],
    ['distributeur_localisation', 'Localisation'],
    ['canal_distribution', 'Canal de distribution'],
    ['prix_vente', 'Prix de vente', ' DT/kg'],
  ],
};

function renderTimeline(lot, historique, donneesParEtape){
  const etapeActuelle = Number(lot.etape);
  const items = [
    { key: 'Production', etape: 1, ts: lot.tsProduction },
    { key: 'Abattage', etape: 2, ts: lot.tsAbattage },
    { key: 'Processing', etape: 3, ts: lot.tsProcessing },
    { key: 'Retailing', etape: 4, ts: lot.tsRetailing },
  ];

  const stepsHtml = items.map((it, idx) => {
    const franchie = etapeActuelle >= it.etape;
    const estActuelle = etapeActuelle === it.etape;
    const cls = franchie ? (estActuelle ? 'current' : 'done') : '';
    const sousTexte = franchie ? (formatDate(it.ts) || '') : 'pas encore franchie';
    const numero = it.etape;

    let corps = '';
    if(franchie){
      const donnees = donneesParEtape && donneesParEtape[idx] ? donneesParEtape[idx].contenu : null;
      const erreur = donneesParEtape && donneesParEtape[idx] ? donneesParEtape[idx].erreur : null;
      if(donnees){
        const champs = CHAMPS_AFFICHES[it.key]
          .filter(([cle]) => donnees[cle] !== undefined && donnees[cle] !== '')
          .map(([cle, libelle, suffixe]) => `<div><b>${libelle}</b>${donnees[cle]}${suffixe || ''}</div>`)
          .join('');
        corps = champs ? `<div class="step-facts">${champs}</div>` : '';
      }else if(erreur){
        corps = `<div class="step-note">Détails indisponibles (${erreur})</div>`;
      }
    }

    return `<div class="step ${cls}">
      <div class="step-dot">${franchie ? '✓' : numero}</div>
      <div class="step-title">${ETAPE_LABEL[it.key]}</div>
      <div class="step-sub">${sousTexte}</div>
      ${corps}
    </div>`;
  }).join('');

  $('timelineH').querySelectorAll('.step').forEach(el => el.remove());
  $('timelineH').insertAdjacentHTML('beforeend', stepsHtml);

  const progressPct = Math.max(0, Math.min(1, (etapeActuelle - 1) / 3)) * 100;
  $('timelineProgress').style.width = `calc((100% - 72px) * ${progressPct / 100})`;

  $('timelineSection').style.display = 'block';
}

// URL de la page lot.html pour un identifiant donne -- utilisee a la fois
// pour la redirection depuis index.html et pour le QR code affiche sur
// lot.html.
function urlDuLot(lotId){
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}lot.html?lot=${encodeURIComponent(lotId)}`;
}

function renderQR(lotId){
  $('qrcode').innerHTML = '';
  const url = urlDuLot(lotId);
  new QRCode($('qrcode'), { text: url, width: 70, height: 70, colorDark: '#10182B', colorLight: '#ffffff' });
  $('qrSection').style.display = 'flex';
}

// Fonction principale : recupere un lot on-chain + IPFS et met a jour
// l'affichage de lot.html. N'existe et ne s'utilise QUE sur lot.html
// (elle suppose la presence des elements #verdictSection, #timelineH, etc.)
async function verifierLot(lotId){
  $('lookupError').style.display = 'none';
  $('verdictSection').style.display = 'none';
  $('timelineSection').style.display = 'none';
  $('qrSection').style.display = 'none';

  $('timelineH').querySelectorAll('.step').forEach(el => el.remove());
  $('timelineProgress').style.width = '0%';

  if(!lotId){ return; }
  if(!CONFIG.CONTRACT_ADDRESS_MULTI || !ethers.isAddress(CONFIG.CONTRACT_ADDRESS_MULTI)){
    $('lookupError').textContent = "Configuration manquante : CONTRACT_ADDRESS_MULTI n'est pas renseignée en tête de fichier.";
    $('lookupError').style.display = 'block';
    return;
  }

  try{
    console.time('[CHRONO] total');
    const c = getContract();

    console.time('[CHRONO] blockchain (consulterLot + historique)');
    let lot, nbEvenements;
    try{
      [lot, nbEvenements] = await Promise.all([
        c.consulterLot(lotId),
        c.nombreEvenementsHistorique(lotId)
      ]);
    }catch(e){
      $('lookupError').textContent = `Aucun lot trouvé pour l'identifiant "${lotId}".`;
      $('lookupError').style.display = 'block';
      return;
    }
    const etape = Number(lot.etape);
    nbEvenements = Number(nbEvenements);

    const historique = await Promise.all(
      Array.from({ length: nbEvenements }, (_, i) => c.evenementHistorique(lotId, i))
    );
    console.timeEnd('[CHRONO] blockchain (consulterLot + historique)');

    renderTimeline(lot, historique, null);

    console.time('[CHRONO] IPFS (toutes les etapes en parallele)');
    const donneesParEtape = await Promise.all(historique.map(async (ev) => {
      try{
        const contenu = await fetchFromIPFS(ev.cidIPFS);
        return { contenu, erreur: null };
      }catch(e){
        return { contenu: null, erreur: e.message };
      }
    }));
    renderTimeline(lot, historique, donneesParEtape);
    console.timeEnd('[CHRONO] IPFS (toutes les etapes en parallele)');

    const detailsEl = $('verdictDetails');
    $('verdictSection').style.display = 'block';
    $('verdictArea').classList.add('show');

    if(etape < 3){
      renderSeal('missing');
      detailsEl.className = 'verdict-details missing';
      detailsEl.innerHTML = `
        <div class="status-line">Résultat pas encore disponible</div>
        <div class="kv">Ce lot n'a pas encore atteint l'étape Processing, où le test anti-fraude est réalisé.</div>`;
    }else{
      let donneesFusionnees = { lot_id: lotId };
      let erreurIpfs = null;
      let cidEnEchec = null;
      for(let i = 0; i < historique.length; i++){
        if(donneesParEtape[i].contenu){
          donneesFusionnees = { ...donneesFusionnees, ...donneesParEtape[i].contenu };
        }else if(!erreurIpfs){
          erreurIpfs = new Error(donneesParEtape[i].erreur);
          cidEnEchec = historique[i].cidIPFS;
        }
      }

      if(erreurIpfs){
        renderSeal('missing');
        detailsEl.className = 'verdict-details missing';
        const lienTest = cidEnEchec ? `${IPFS_GATEWAYS[0]}/${cidEnEchec}` : null;
        detailsEl.innerHTML = `
          <div class="status-line">Vérification impossible</div>
          <div class="kv">${erreurIpfs.message}</div>
          ${cidEnEchec ? `<div class="kv"><b>CID en échec</b> <span style="font-family:var(--font-mono); font-size:0.72rem;">${cidEnEchec}</span></div>` : ''}
          ${lienTest ? `<div class="kv"><a href="${lienTest}" target="_blank" rel="noopener">Tester ce CID directement dans un nouvel onglet ↗</a></div>` : ''}
          <div class="kv"><b>Résultat IA (on-chain)</b> ${lot.resultatDetectionIA}</div>`;
      }else{
        const hashRecalcule = await recalculerHash(donneesFusionnees);
        const integre = await c.verifierIntegrite(lotId, '0x' + hashRecalcule);
        renderSeal(integre ? 'ok' : 'fraud');
        detailsEl.className = 'verdict-details ' + (integre ? 'ok' : 'fraud');
        detailsEl.innerHTML = `
          <div class="status-line">${integre ? 'Données vérifiées, aucune altération détectée' : 'Incohérence détectée avec le registre'}</div>
          <div class="kv"><b>Résultat IA</b> ${lot.resultatDetectionIA}</div>
          <div class="kv"><b>% de porc estimé</b> ${lot.pourcentagePorcEstime}%</div>`;
      }
    }

    try{
      renderQR(lotId);
    }catch(qrError){
      console.warn('[QR] Génération du QR code impossible :', qrError.message);
      $('qrSection').style.display = 'none';
    }

    console.timeEnd('[CHRONO] total');
  }catch(e){
    $('lookupError').textContent = "Erreur : " + e.message;
    $('lookupError').style.display = 'block';
  }
}
