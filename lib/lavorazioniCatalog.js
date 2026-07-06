'use strict';

// Porting 1:1 di src/data/lavorazioniData.ts (frontend, C:\Users\ricka\palladia)
// — stessa struttura, stesse stringhe esatte. Necessario perché il wizard POS
// (StepLavorazioni.tsx) fa match ESATTO stringa-per-stringa contro questo
// catalogo per decidere cosa mostrare spuntato: se Ladia scrive un testo
// libero non presente qui, la voce non risulterà mai selezionata nel wizard.
// Tenere sincronizzato a mano con il frontend se il catalogo cambia.

const lavorazioniDatabase = [
  {
    id: 'allestimento',
    nome: 'Allestimento del Cantiere',
    items: [
      'Recinzione cantiere', 'Baracche di cantiere', 'Impianto elettrico di cantiere',
      'Impianto idrico di cantiere', 'Segnaletica di cantiere', 'Viabilità interna',
      'Aree di stoccaggio materiali', 'Zone carico/scarico', 'Illuminazione cantiere',
      'Installazione gru a torre', 'Montaggio ponteggio', 'Installazione ascensore da cantiere',
      'Predisposizione linee vita', 'Area lavaggio ruote', 'Parcheggio mezzi',
      'Ufficio direzione lavori', 'Spogliatoi e servizi igienici', 'Locale mensa',
      'Infermeria di cantiere', 'Deposito DPI', 'Area rifiuti e cassonetti',
      'Installazione videosorveglianza', 'Sistema antintrusione', 'Cabina elettrica temporanea',
    ],
  },
  {
    id: 'demolizioni',
    nome: 'Demolizioni e Rimozioni',
    items: [
      'Demolizione murature portanti', 'Demolizione tramezzi', 'Rimozione pavimenti',
      'Rimozione rivestimenti', 'Rimozione intonaci', 'Demolizione solai',
      'Demolizione copertura', 'Rimozione serramenti', 'Rimozione impianto elettrico',
      'Rimozione impianto idraulico', 'Rimozione impianto di riscaldamento', 'Demolizione scale',
      'Taglio strutture in c.a.', 'Rimozione controsoffitti', 'Demolizione muri di contenimento',
      'Rimozione elementi in ferro', 'Smaltimento materiali di risulta', 'Bonifica amianto',
      'Rimozione guaine impermeabilizzanti', 'Demolizione cordoli e marciapiedi',
      'Rimozione recinzioni esistenti', 'Sradicamento alberature',
    ],
  },
  {
    id: 'scavi',
    nome: 'Scavi e Fondazioni',
    items: [
      'Scavo a sezione obbligata', 'Scavo a sezione aperta', 'Scavo per fondazioni',
      'Scavo per sottoservizi', 'Palificazione', 'Micropali', 'Diaframmi',
      'Consolidamento terreno', 'Rinterri e riporti', 'Armatura casseforme fondazioni',
      'Getto fondazioni in c.a.', 'Platea di fondazione', 'Travi rovesce', 'Vespaio aerato',
    ],
  },
  {
    id: 'strutture',
    nome: 'Strutture',
    items: [
      'Carpenteria in c.a. pilastri', 'Carpenteria in c.a. travi', 'Getto solai in c.a.',
      'Strutture prefabbricate', 'Strutture in acciaio', 'Strutture in legno lamellare',
      'Scale in c.a.', 'Murature portanti', 'Cordoli e architravi', 'Solai in laterocemento',
      'Solai collaboranti', 'Giunti strutturali', 'Rinforzi strutturali FRP', 'Cerchiature metalliche',
    ],
  },
  {
    id: 'murature',
    nome: 'Murature',
    items: [
      'Murature in laterizio', 'Tramezzi interni', 'Murature in blocchi', 'Contropareti',
      'Muri di tamponamento', 'Murature faccia vista', 'Muri di contenimento',
      'Parapetti in muratura', 'Canne fumarie in muratura', 'Vespai', 'Massetti', 'Sottofondi',
    ],
  },
  {
    id: 'risanamento',
    nome: 'Risanamento e Consolidamento',
    items: [
      'Iniezioni di resina', 'Consolidamento murature', 'Risanamento calcestruzzo',
      "Trattamento ferri d'armatura", 'Deumidificazione murature', 'Barriera chimica',
      'Consolidamento volte', 'Rinforzo solai', 'Cuci-scuci murature', 'Tiranti e catene',
    ],
  },
  {
    id: 'intonaci',
    nome: 'Intonaci e Finiture',
    items: [
      'Intonaco civile interno', 'Intonaco civile esterno', 'Intonaco rustico', 'Rasatura pareti',
      'Stucco veneziano', 'Intonaco deumidificante', 'Intonaco termico', 'Intonaco armato',
      'Cornici e modanature', 'Zoccolature',
    ],
  },
  {
    id: 'cappotto',
    nome: 'Cappotto Termico',
    items: [
      'Cappotto in EPS', 'Cappotto in lana di roccia', 'Cappotto in fibra di legno',
      'Cappotto in sughero', 'Fissaggio pannelli isolanti', "Rete d'armatura",
      'Rasatura cappotto', 'Finitura cappotto', 'Elementi di giunzione',
      'Profili di partenza e chiusura',
    ],
  },
  {
    id: 'impermeabilizzazioni',
    nome: 'Impermeabilizzazioni',
    items: [
      'Guaine bituminose', 'Membrane sintetiche', 'Impermeabilizzazione liquida',
      'Impermeabilizzazione interrata', 'Impermeabilizzazione terrazzi',
      'Impermeabilizzazione bagni', 'Giunti di dilatazione impermeabili', 'Drenaggi',
      'Barriera al vapore', 'Scossaline e gronde',
    ],
  },
  {
    id: 'impianti-elettrici',
    nome: 'Impianti Elettrici',
    items: [
      'Quadro elettrico generale', 'Impianto elettrico civile', 'Impianto elettrico industriale',
      'Impianto citofonico/videocitofonico', 'Impianto TV/SAT', 'Impianto dati/telefono',
      'Impianto fotovoltaico', 'Impianto domotico', 'Illuminazione interna',
      'Illuminazione esterna', 'Impianto di terra', 'Impianto parafulmine',
    ],
  },
  {
    id: 'impianti-idro',
    nome: 'Impianti Idraulici e Termici',
    items: [
      'Impianto idrico-sanitario', 'Impianto di scarico', 'Impianto di riscaldamento',
      'Impianto di raffrescamento', 'Impianto a pavimento', 'Caldaia/pompa di calore',
      'Pannelli solari termici', 'VMC ventilazione meccanica', 'Impianto gas',
      'Impianto antincendio', 'Trattamento acque', 'Autoclave',
    ],
  },
  {
    id: 'pavimenti',
    nome: 'Pavimenti e Rivestimenti',
    items: [
      'Pavimento in gres porcellanato', 'Pavimento in ceramica', 'Pavimento in legno/parquet',
      'Pavimento in resina', 'Pavimento in marmo/pietra', 'Rivestimento bagno',
      'Rivestimento cucina', 'Battiscopa', 'Soglie e davanzali', 'Gradini e alzate',
    ],
  },
  {
    id: 'cartongesso',
    nome: 'Cartongesso e Controsoffitti',
    items: [
      'Pareti in cartongesso', 'Contropareti in cartongesso', 'Controsoffitto in cartongesso',
      'Controsoffitto in fibra minerale', 'Velette e ribassamenti',
      'Nicchie e librerie in cartongesso', 'Cartongesso ignifugo', 'Cartongesso idrorepellente',
    ],
  },
  {
    id: 'coperture',
    nome: 'Coperture',
    items: [
      'Copertura in tegole', 'Copertura in coppi', 'Copertura piana', 'Copertura in lamiera',
      'Copertura in legno', 'Isolamento copertura', 'Lucernari e abbaini', 'Canali di gronda',
      'Pluviali', 'Linee vita permanenti',
    ],
  },
  {
    id: 'serramenti',
    nome: 'Serramenti',
    items: [
      'Serramenti in PVC', 'Serramenti in alluminio', 'Serramenti in legno', 'Porte interne',
      'Portoncino blindato', 'Portone garage', 'Persiane/scuri', 'Tapparelle',
      'Grate di sicurezza', 'Vetrate fisse',
    ],
  },
  {
    id: 'tinteggiature',
    nome: 'Tinteggiature',
    items: [
      'Tinteggiatura interna', 'Tinteggiatura esterna', 'Verniciatura legno', 'Verniciatura ferro',
      'Trattamento antimuffa', 'Decorazioni murali', 'Pittura lavabile', 'Smalto murale',
    ],
  },
  {
    id: 'isolamenti',
    nome: 'Isolamenti',
    items: [
      'Isolamento termico pareti', 'Isolamento termico solaio', 'Isolamento acustico',
      'Isolamento intercapedine', 'Insufflaggio', 'Pannelli fonoassorbenti',
      'Tappetino anticalpestio', 'Barriera al vapore',
    ],
  },
  {
    id: 'pavimentazioni-esterne',
    nome: 'Pavimentazioni Esterne',
    items: [
      'Marciapiedi', 'Pavimentazione autobloccanti', 'Asfalto', 'Masselli in pietra',
      'Ghiaia stabilizzata', 'Cordonate', 'Rampe e scivoli', 'Pozzetti e caditoie',
    ],
  },
  {
    id: 'opere-complementari',
    nome: 'Opere Complementari',
    items: [
      'Ascensore', 'Montacarichi', 'Scale metalliche', 'Ringhiere e parapetti',
      'Recinzioni definitive', 'Cancelli e cancelletti', 'Pergolati e tettoie',
      'Opere in ferro', 'Opere da fabbro', 'Opere da falegname',
    ],
  },
  {
    id: 'verde',
    nome: 'Opere a Verde',
    items: [
      'Preparazione terreno', 'Piantumazione alberi', 'Tappeto erboso', 'Impianto irrigazione',
      'Fioriere e aiuole', 'Drenaggio aree verdi',
    ],
  },
];

// Ricerca case-insensitive su nome categoria + items, max ~30 risultati totali
// raggruppati per categoria — per proporre a Ladia SOLO stringhe esatte del
// catalogo, mai testo libero inventato.
function searchLavorazioni(query, category) {
  const q = (query || '').trim().toLowerCase();
  const cat = (category || '').trim().toLowerCase();

  const filtered = lavorazioniDatabase
    .filter(c => !cat || c.nome.toLowerCase().includes(cat) || c.id === cat)
    .map(c => ({
      id: c.id,
      nome: c.nome,
      items: !q
        ? c.items
        : c.items.filter(item => item.toLowerCase().includes(q) || c.nome.toLowerCase().includes(q)),
    }))
    .filter(c => c.items.length > 0);

  let count = 0;
  const capped = [];
  for (const c of filtered) {
    if (count >= 30) break;
    const room = 30 - count;
    const items = c.items.slice(0, room);
    capped.push({ id: c.id, nome: c.nome, items });
    count += items.length;
  }
  return capped;
}

module.exports = { lavorazioniDatabase, searchLavorazioni };
