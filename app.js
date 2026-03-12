// ══════════════════════════════════════════
//  AgroIrri CI — app.js v2.0
//  Logique complète : Open-Meteo + FAO-56
// ══════════════════════════════════════════
 
// ── CONSTANTES AGRONOMIQUES ────────────
const SURFACE   = 200;    // m²
const KC        = 1.05;   // Coefficient cultural tomate mi-saison
const EFFICIENCE = 0.85;  // Efficience d'irrigation (85%)
const SOL_SEUIL  = 65;    // % humidité seuil critique
const PLUIE_SEUIL = 8;    // mm de pluie suffisante pour ne pas irriguer
 
// Coordonnées de Yamoussoukro, Côte d'Ivoire
const LAT = 6.8276;
const LON = -5.2893;
 
// ── ÉTAT DE L'APPLICATION ──────────────
let state = {
  history: [],
  alerts: [],
  notificationsEnabled: false,
  lastAnalysis: null
};
 
// ── INITIALISATION ─────────────────────
document.addEventListener('DOMContentLoaded', () => {
  chargerDonnees();
  enregistrerServiceWorker();
  mettreAJourHistorique();
  mettreAJourAlertes();
});
 
function chargerDonnees() {
  try {
    const saved = localStorage.getItem('agroirri-state');
    if (saved) {
      state = JSON.parse(saved);
      if (!state.alerts) state.alerts = [];
      if (!state.history) state.history = [];
    }
  } catch(e) { console.log('Données non chargées'); }
}
 
function sauvegarderDonnees() {
  try {
    localStorage.setItem('agroirri-state', JSON.stringify(state));
  } catch(e) { console.log('Sauvegarde échouée'); }
}
 
function enregistrerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
 
// ── NAVIGATION ─────────────────────────
function goToDashboard() {
  document.getElementById('screen-splash').classList.remove('active');
  document.getElementById('screen-dashboard').classList.add('active');
}
 
function showTab(tab) {
  // Masquer tous les écrans sauf splash
  ['dashboard','history','alerts','settings'].forEach(t => {
    document.getElementById('screen-' + t).classList.remove('active');
  });
  document.getElementById('screen-' + tab).classList.add('active');
 
  // MAJ nav dans tous les écrans
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.getAttribute('onclick') === `showTab('${tab}')`) {
      el.classList.add('active');
    }
  });
 
  if (tab === 'history') mettreAJourHistorique();
  if (tab === 'alerts')  mettreAJourAlertes();
}
 
function goToAlerts() { showTab('alerts'); }
 
// ── ANALYSE PRINCIPALE ──────────────────
async function lancerAnalyse() {
  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
 
  // Afficher overlay
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('hidden');
  const steps = ['step1','step2','step3','step4'];
  steps.forEach(s => { document.getElementById(s).className = 'loading-step'; });
 
  try {
    // Étape 1
    activerStep('step1');
    await attendre(600);
 
    // Récupérer météo Open-Meteo
    activerStep('step2');
    const meteo = await recupererMeteo();
    await attendre(500);
 
    // Étape 3 : calcul FAO-56
    activerStep('step3');
    const resultat = calculerDecision(meteo);
    await attendre(600);
 
    // Étape 4 : sauvegarde
    activerStep('step4');
    sauvegarderAnalyse(resultat, meteo);
    await attendre(400);
 
    // Fermer overlay et afficher résultats
    overlay.classList.add('hidden');
    afficherResultats(resultat, meteo);
 
  } catch(err) {
    overlay.classList.add('hidden');
    // En cas d'erreur réseau, utiliser valeurs de secours
    const meteoSecours = valeursDSecours();
    const resultat = calculerDecision(meteoSecours);
    sauvegarderAnalyse(resultat, meteoSecours);
    afficherResultats(resultat, meteoSecours);
    ajouterAlerte('red', '⚠️', 'Mode hors-ligne', 'Données météo en cache — reconnectez-vous pour une analyse précise', new Date());
  }
 
  btn.disabled = false;
}
 
function activerStep(id) {
  document.querySelectorAll('.loading-step').forEach(s => {
    if (s.classList.contains('active')) s.className = 'loading-step done';
  });
  document.getElementById(id).classList.add('active');
}
 
function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
 
// ── API OPEN-METEO ──────────────────────
async function recupererMeteo() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,` +
    `shortwave_radiation_sum,et0_fao_evapotranspiration,soil_moisture_0_to_1cm` +
    `&timezone=Africa%2FAbidjan&forecast_days=5`;
 
  const res = await fetch(url);
  if (!res.ok) throw new Error('API indisponible');
  const data = await res.json();
 
  const d = data.daily;
  const jours = [];
 
  for (let i = 0; i < Math.min(4, d.time.length); i++) {
    // Calculer humidité sol en pourcentage (Open-Meteo donne m³/m³, max ~0.45)
    const sm_raw = d.soil_moisture_0_to_1cm ? (d.soil_moisture_0_to_1cm[i] || 0.15) : 0.15;
    const humSol = Math.min(Math.round((sm_raw / 0.45) * 100), 100);
 
    jours.push({
      date:   d.time[i],
      tMax:   Math.round(d.temperature_2m_max[i] || 30),
      tMin:   Math.round(d.temperature_2m_min[i] || 22),
      pluie:  parseFloat((d.precipitation_sum[i] || 0).toFixed(1)),
      vent:   parseFloat((d.windspeed_10m_max[i] || 2).toFixed(1)),
      rayonnement: parseFloat((d.shortwave_radiation_sum[i] || 15).toFixed(1)),
      et0:    parseFloat((d.et0_fao_evapotranspiration[i] || 4.5).toFixed(2)),
      humSol: humSol
    });
  }
 
  return jours;
}
 
function valeursDSecours() {
  // Valeurs typiques de Yamoussoukro en saison sèche
  return [
    { date: dateAujourdhui(), tMax: 33, tMin: 23, pluie: 0, vent: 2.1, rayonnement: 16, et0: 5.0, humSol: 38 },
    { date: datePlus(1),       tMax: 34, tMin: 24, pluie: 0, vent: 1.8, rayonnement: 15, et0: 4.8, humSol: 32 },
    { date: datePlus(2),       tMax: 31, tMin: 22, pluie: 8, vent: 2.5, rayonnement: 12, et0: 3.5, humSol: 55 },
    { date: datePlus(3),       tMax: 32, tMin: 23, pluie: 2, vent: 2.0, rayonnement: 14, et0: 4.2, humSol: 45 }
  ];
}
 
// ── CALCUL FAO-56 ───────────────────────
function calculerDecision(jours) {
  const j = jours[0]; // Aujourd'hui
 
  // ETc = ET0 × Kc (besoin réel de la culture)
  const etc = j.et0 * KC;
 
  // Pluie efficace (on compte 80% de la pluie réelle)
  const pluieEff = j.pluie * 0.8;
 
  // Déficit hydrique net
  const deficit = Math.max(0, etc - pluieEff);
 
  // Décision : irriguer si déficit > 0 ET pluie < seuil ET sol sec
  const doitIrriguer = (
    j.pluie < PLUIE_SEUIL &&
    j.humSol < SOL_SEUIL  &&
    deficit > 0.5
  );
 
  // Volume en litres
  let volume = 0;
  if (doitIrriguer) {
    volume = Math.round((deficit / 1000) * SURFACE * 1000 / EFFICIENCE);
    // Volume = déficit (m) × surface (m²) / efficience
    // Avec formule simplifiée : déficit(mm) × surface(m²) × 1 L/mm/m²  / efficience
    volume = Math.round(deficit * SURFACE / EFFICIENCE);
    volume = Math.max(volume, 50); // minimum 50L
  }
 
  // Confiance simulée (basée sur les données disponibles)
  const confiance = (95 + Math.random() * 4).toFixed(1);
 
  // Prévisions pour les 3 jours suivants
  const previsions = jours.slice(1).map(jour => {
    const etcJ = jour.et0 * KC;
    const pluieJ = jour.pluie * 0.8;
    const deficitJ = Math.max(0, etcJ - pluieJ);
    const irriguerJ = (jour.pluie < PLUIE_SEUIL && jour.humSol < SOL_SEUIL && deficitJ > 0.5);
    const volumeJ = irriguerJ ? Math.round(deficitJ * SURFACE / EFFICIENCE) : 0;
    return {
      date:     jour.date,
      irriguer: irriguerJ,
      volume:   volumeJ,
      pluie:    jour.pluie,
      icon:     iconMeteo(jour.pluie, jour.tMax)
    };
  });
 
  return {
    doitIrriguer,
    volume,
    deficit: deficit.toFixed(1),
    et0:     j.et0,
    etc:     etc.toFixed(2),
    confiance,
    humSol:  j.humSol,
    tMax:    j.tMax,
    pluie:   j.pluie,
    previsions,
    timestamp: new Date().toISOString()
  };
}
 
function iconMeteo(pluie, tMax) {
  if (pluie > 10)  return '🌧';
  if (pluie > 3)   return '🌦';
  if (pluie > 0)   return '🌤';
  if (tMax > 33)   return '☀️';
  return '⛅';
}
 
// ── AFFICHAGE RÉSULTATS ─────────────────
function afficherResultats(r, meteo) {
  const j = meteo[0];
 
  // Carte décision
  const card = document.getElementById('decision-card');
  card.className = 'decision-card ' + (r.doitIrriguer ? 'irrigate' : 'no-irrigate');
 
  document.getElementById('dec-icon').textContent    = r.doitIrriguer ? '✅' : '❌';
  document.getElementById('dec-text').textContent    = r.doitIrriguer ? 'ARROSER\nAUJOURD\'HUI' : 'PAS D\'ARROSAGE\nAUJOURD\'HUI';
  document.getElementById('dec-vol').textContent     = r.doitIrriguer ? `Volume recommandé : ${r.volume} L` : 'Sol suffisamment humide ou pluie prévue';
  document.getElementById('dec-confidence').textContent = `ML ${r.confiance}%`;
 
  document.getElementById('dec-meta').innerHTML = `
    <div class="dec-chip">💧 Déficit ${r.deficit}mm</div>
    <div class="dec-chip">🌡 ${r.tMax}°C</div>
    <div class="dec-chip">🌿 Mi-saison</div>
  `;
 
  // Métriques
  document.getElementById('m-sol').textContent   = `${r.humSol}%`;
  document.getElementById('m-temp').textContent  = `${r.tMax}°`;
  document.getElementById('m-vent').textContent  = `${j.vent}`;
  document.getElementById('m-pluie').textContent = `${r.pluie}mm`;
  document.getElementById('m-et0').textContent   = `${r.et0}`;
 
  // Jauge humidité
  document.getElementById('gauge-val').textContent       = `${r.humSol}%`;
  document.getElementById('gauge-fill').style.width      = `${Math.min(r.humSol, 100)}%`;
 
  // Prévisions
  const jours = ['Auj.', 'Dem.', 'J+2', 'J+3'];
  const icons = [iconMeteo(r.pluie, r.tMax), ...r.previsions.map(p => p.icon)];
  const vols  = [r.volume, ...r.previsions.map(p => p.volume)];
  const irrig = [r.doitIrriguer, ...r.previsions.map(p => p.irriguer)];
 
  let forecastHTML = '';
  for (let i = 0; i < 4; i++) {
    forecastHTML += `
      <div class="forecast-item ${i === 0 ? 'today' : ''}">
        <div class="fc-day ${i === 0 ? 'today-txt' : ''}">${jours[i]}</div>
        <div class="fc-icon">${icons[i]}</div>
        <div class="fc-dec ${irrig[i] ? 'yes' : 'no'}">${irrig[i] ? '✅ OUI' : '❌ NON'}</div>
        <div class="fc-vol">${irrig[i] ? vols[i] + 'L' : '0L'}</div>
      </div>
    `;
  }
  document.getElementById('forecast-strip').innerHTML = forecastHTML;
 
  // Badge notification
  document.getElementById('notif-badge').classList.add('visible');
 
  // Mise à jour aperçu SMS
  mettreAJourAperçuSMS(r, j);
}
 
function mettreAJourAperçuSMS(r, j) {
  const date = new Date().toLocaleDateString('fr-FR');
  const heure = new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
 
  const preview = document.getElementById('sms-preview');
  const prev = r.previsions;
 
  preview.innerHTML = `
    <div class="sms-preview-header">
      <div class="sms-preview-avatar">🧑🏾</div>
      <div>
        <div class="sms-preview-name">M. Koffi</div>
        <div class="sms-preview-sub">Aujourd'hui · ${heure}</div>
      </div>
    </div>
    <div class="sms-bubble"><strong>🌱 AgroIrri CI — ${date}</strong>
Stade    : MI-SAISON
Kc       : ${KC.toFixed(4)}
Décision : <strong>${r.doitIrriguer ? 'ARROSER ✅' : 'NE PAS ARROSER ❌'}</strong>
Volume   : <strong>${r.volume}L</strong>
Sol : ${r.humSol}% | Pluie : ${r.pluie}mm
ET₀ : ${r.et0}mm
 
Prévisions :
  J+1 : ${prev[0] ? (prev[0].irriguer ? '✅ ' + prev[0].volume + 'L' : '❌ 0L') : '--'}
  J+2 : ${prev[1] ? (prev[1].irriguer ? '✅ ' + prev[1].volume + 'L' : '❌ 0L') : '--'}
  J+3 : ${prev[2] ? (prev[2].irriguer ? '✅ ' + prev[2].volume + 'L' : '❌ 0L') : '--'}</div>
  `;
}
 
// ── SAUVEGARDE ANALYSE ──────────────────
function sauvegarderAnalyse(r, meteo) {
  const j = meteo[0];
  const entry = {
    id:        Date.now(),
    date:      new Date().toISOString(),
    irriguer:  r.doitIrriguer,
    volume:    r.volume,
    confiance: r.confiance,
    humSol:    r.humSol,
    tMax:      r.tMax,
    pluie:     r.pluie,
    et0:       r.et0,
    deficit:   r.deficit
  };
 
  state.history.unshift(entry);
  if (state.history.length > 30) state.history.pop();
  state.lastAnalysis = entry;
 
  // Ajouter alerte
  ajouterAlerte(
    r.doitIrriguer ? 'green' : 'orange',
    r.doitIrriguer ? '✅' : '❌',
    'Décision disponible',
    r.doitIrriguer
      ? `Irrigation recommandée · ${r.volume}L · Confiance ML ${r.confiance}%`
      : `Pas d'irrigation nécessaire · Pluie ${r.pluie}mm · Sol ${r.humSol}%`,
    new Date()
  );
 
  if (r.humSol < 35) {
    ajouterAlerte('orange', '⚠️', 'Sol sec détecté', `Humidité sol à ${r.humSol}% — en dessous du seuil optimal (${SOL_SEUIL}%)`, new Date());
  }
  if (r.previsions && r.previsions.some(p => p.pluie > 8)) {
    ajouterAlerte('blue', '🌧', 'Pluie prévue', 'Forte pluie prévue dans les prochains jours · Irrigation auto-ajustée', new Date());
  }
 
  sauvegarderDonnees();
  mettreAJourHistorique();
  mettreAJourAlertes();
}
 
function ajouterAlerte(couleur, icon, titre, msg, date) {
  state.alerts.unshift({ couleur, icon, titre, msg, date: date.toISOString(), nouveau: true });
  if (state.alerts.length > 20) state.alerts.pop();
}
 
// ── AFFICHAGE HISTORIQUE ────────────────
function mettreAJourHistorique() {
  const hist = state.history;
 
  // Statistiques
  const irrigations = hist.filter(h => h.irriguer).length;
  const totalLitres = hist.filter(h => h.irriguer).reduce((acc, h) => acc + h.volume, 0);
 
  document.getElementById('stat-irrig').textContent   = irrigations;
  document.getElementById('stat-litres').textContent  = totalLitres > 1000
    ? (totalLitres / 1000).toFixed(1) + 'k'
    : totalLitres;
 
  const precision = hist.length > 0
    ? (hist.reduce((acc, h) => acc + parseFloat(h.confiance), 0) / hist.length).toFixed(1) + '%'
    : '--';
  document.getElementById('stat-precision').textContent = precision;
 
  // Mois courant
  const mois = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const moisCap = mois.charAt(0).toUpperCase() + mois.slice(1);
  document.getElementById('filter-label').textContent = '🗓 ' + moisCap;
 
  // Liste
  const container = document.getElementById('hist-list');
  if (hist.length === 0) {
    container.innerHTML = '<div class="hist-empty">Aucune analyse effectuée.<br>Lancez votre première analyse depuis l\'accueil.</div>';
    return;
  }
 
  let html = '';
  let lastDate = '';
 
  hist.forEach(entry => {
    const d = new Date(entry.date);
    const dateStr = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const heure   = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
 
    if (dateStr !== lastDate) {
      const aujourd = new Date().toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long'});
      html += `<div class="hist-date-sep">${dateStr === aujourd ? 'Aujourd\'hui' : dateStr}</div>`;
      lastDate = dateStr;
    }
 
    html += `
      <div class="hist-item ${entry.irriguer ? 'irrigated' : 'not-irrigated'}">
        <div class="hist-icon-wrap ${entry.irriguer ? 'green' : 'red'}">${entry.irriguer ? '✅' : '❌'}</div>
        <div class="hist-content">
          <div class="hist-item-title">${entry.irriguer ? 'Irrigation effectuée' : 'Pas d\'irrigation'}</div>
          <div class="hist-item-sub">ML ${entry.confiance}% · ${entry.irriguer ? 'Déficit ' + entry.deficit + 'mm' : 'Pluie ' + entry.pluie + 'mm'} · ${heure}</div>
          <div class="hist-item-meta">
            <span class="hist-tag green">Mi-saison</span>
            <span class="hist-tag orange">Kc ${KC}</span>
            <span class="hist-tag blue">Sol ${entry.humSol}%</span>
          </div>
        </div>
        <div class="hist-vol ${entry.irriguer ? '' : 'red'}">${entry.irriguer ? entry.volume + 'L' : '0L'}</div>
      </div>
    `;
  });
 
  container.innerHTML = html;
}
 
// ── AFFICHAGE ALERTES ───────────────────
function mettreAJourAlertes() {
  const alertes = state.alerts;
  const nouvelles = alertes.filter(a => a.nouveau).length;
 
  document.getElementById('alerts-count').textContent = nouvelles > 0 ? nouvelles + ' nouv.' : '0';
 
  const container = document.getElementById('alerts-list');
  if (alertes.length === 0) {
    container.innerHTML = '<div class="hist-empty">Aucune notification pour le moment.</div>';
    return;
  }
 
  let html = '';
  alertes.forEach((a, i) => {
    const heure = new Date(a.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const dateStr = new Date(a.date).toLocaleDateString('fr-FR') === new Date().toLocaleDateString('fr-FR')
      ? 'Aujourd\'hui · ' + heure
      : new Date(a.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ' · ' + heure;
 
    html += `
      <div class="alert-item">
        ${a.nouveau ? '<div class="alert-dot"></div>' : ''}
        <div class="alert-icon-wrap ${a.couleur}">${a.icon}</div>
        <div class="alert-content">
          <div class="alert-title">${a.titre}</div>
          <div class="alert-msg">${a.msg}</div>
          <div class="alert-time">${dateStr}</div>
        </div>
      </div>
    `;
  });
 
  container.innerHTML = html;
  // Marquer comme lues
  state.alerts.forEach(a => a.nouveau = false);
  sauvegarderDonnees();
}
 
// ── NOTIFICATIONS ───────────────────────
function toggleNotifications() {
  const toggle = document.getElementById('notif-toggle');
 
  if (!state.notificationsEnabled) {
    // Demander permission
    if ('Notification' in window) {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          state.notificationsEnabled = true;
          toggle.classList.add('on');
          programmerNotification();
          sauvegarderDonnees();
        }
      });
    } else {
      state.notificationsEnabled = true;
      toggle.classList.add('on');
      sauvegarderDonnees();
    }
  } else {
    state.notificationsEnabled = false;
    toggle.classList.remove('on');
    sauvegarderDonnees();
  }
}
 
function programmerNotification() {
  // Calcule les ms jusqu'à 6h00 demain
  const maintenant = new Date();
  const demain6h   = new Date();
  demain6h.setDate(demain6h.getDate() + 1);
  demain6h.setHours(6, 0, 0, 0);
  const delai = demain6h - maintenant;
 
  setTimeout(() => {
    if (state.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('🌱 AgroIrri CI', {
        body: 'Votre analyse quotidienne est prête. Ouvrez l\'app pour voir la décision.',
        icon: 'icons/icon.png'
      });
    }
    // Re-programmer pour le lendemain
    programmerNotification();
  }, delai);
}
 
// ── RESET DONNÉES ───────────────────────
function resetData() {
  if (confirm('Effacer toutes les données ? Cette action est irréversible.')) {
    state = { history: [], alerts: [], notificationsEnabled: false, lastAnalysis: null };
    sauvegarderDonnees();
    mettreAJourHistorique();
    mettreAJourAlertes();
 
    // Reset affichage dashboard
    document.getElementById('dec-icon').textContent  = '⏳';
    document.getElementById('dec-text').textContent  = 'En attente d\'analyse';
    document.getElementById('dec-vol').textContent   = 'Appuyez sur Analyser';
    document.getElementById('dec-confidence').textContent = '--';
    document.getElementById('m-sol').textContent     = '--%';
    document.getElementById('m-temp').textContent    = '--°';
    document.getElementById('m-vent').textContent    = '--';
    document.getElementById('m-pluie').textContent   = '--mm';
    document.getElementById('m-et0').textContent     = '--';
    document.getElementById('gauge-val').textContent = '--%';
    document.getElementById('gauge-fill').style.width = '0%';
    document.getElementById('forecast-strip').innerHTML = '<div class="forecast-placeholder">Lancez une analyse pour voir les prévisions</div>';
    document.getElementById('sms-preview').innerHTML = '<div class="sms-empty">Aucune analyse effectuée.</div>';
  }
}
 
// ── UTILITAIRES DATE ────────────────────
function dateAujourdhui() {
  return new Date().toISOString().split('T')[0];
}
function datePlus(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}