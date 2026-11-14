/** The table the detector reads: which scripts name a language on their own,
 *  and the function words that separate languages sharing an alphabet. Data,
 *  never logic.
 *  NOT here: how the table is used, or any threshold
 *  (`pipeline/detect-language.ts`).
 *  Called by: `pipeline/detect-language.ts`. */

/**
 * Profils de langue — la TABLE que consulte `detect-language.ts`. Données, pas
 * logique : le détecteur ne connaît aucune langue en dur.
 *
 * DEUX MÉCANISMES, PAS UN
 * =======================
 * 1. `SCRIPT_PROFILES` — quand une écriture désigne une langue à elle seule
 *    (kana ⇒ japonais, hangul ⇒ coréen, han sans kana ⇒ chinois, grec, hébreu,
 *    arabe). Ces langues n'ont pas de mots-outils séparables par une
 *    tokenisation sur frontières alphabétiques : le japonais et le chinois ne
 *    mettent pas d'espaces entre les mots. L'écriture les tranche mieux qu'une
 *    liste de mots ne le ferait.
 * 2. `FUNCTION_WORDS` — pour les écritures latine et cyrillique, où plusieurs
 *    langues partagent le même alphabet. Score = proportion des tokens de
 *    l'échantillon appartenant au jeu d'une langue.
 *
 * POURQUOI LES JEUX SE RECOUPENT, ET POURQUOI C'EST VOULU
 * ======================================================
 * Chaque jeu contient les mots réellement les plus fréquents de SA langue,
 * même quand une autre langue les partage : `de` est à la fois français,
 * espagnol, portugais et néerlandais, `a` est hongrois, roumain, portugais et
 * anglais, `i` est polonais et scandinave. Les retirer pour « désambiguïser »
 * serait l'erreur exacte à ne pas commettre — un mot omis d'une langue mais
 * listé par une concurrente donne le point à la concurrente sur un texte qui
 * appartient pourtant à la première. Le score étant RELATIF, le recoupement
 * s'annule de lui-même : c'est la marge, pas la disjonction des jeux, qui
 * arbitre.
 *
 * CE QUE CETTE TABLE NE PEUT PAS FAIRE, ET C'EST ASSUMÉ
 * ====================================================
 * Les langues proches se bloquent mutuellement : da/no/sv d'abord, puis es/pt,
 * cs/pl et ru/uk. C'est la faiblesse connue de la méthode par mots-outils. La
 * règle de MARGE de `detect-language.ts` la transforme en abstention : deux
 * langues à score voisin ⇒ `undefined` ⇒ **pas de traduction**. Un document
 * danois a donc de bonnes chances de n'être jamais traduit ; il ne sera jamais
 * traduit À TORT, ce qui est le sens dans lequel on veut se tromper. Les mots
 * réellement discriminants sont volontairement présents (og/och, af/av,
 * ikke/inte, etter/efter, seg/sig, mye/meget/mycket) pour laisser une chance à
 * la résolution quand le texte en contient.
 *
 * Les jeux ci-dessous sont écrits à la main, pas dérivés d'un corpus. Les tests
 * dirigés les éprouvent sur des textes eux aussi écrits à la main : ils
 * prouvent que le MÉCANISME classe, jamais un taux de justesse sur des
 * documents réels. La calibration sur corpus réel reste ouverte (STATUS.md).
 *
 * Une langue absente de cette table n'est jamais détectée — le détecteur rend
 * `undefined`, donc aucune traduction. Y ajouter une langue est additif.
 */

/** Écritures qui identifient une langue à elles seules. L'ORDRE COMPTE : un
 *  texte japonais mêle kana et han, donc le test kana doit précéder le test
 *  han, sinon il serait classé chinois. */
export const SCRIPT_PROFILES: readonly { lang: string; pattern: RegExp }[] = [
  // Hiragana (U+3040-309F) + katakana (U+30A0-30FF) : présents dans tout texte
  // japonais courant, absents du chinois.
  { lang: "ja", pattern: /[぀-ヿ]/gu },
  // Hangul : syllabes précomposées (U+AC00-D7AF) + jamo (U+1100-11FF).
  { lang: "ko", pattern: /[가-힯ᄀ-ᇿ]/gu },
  // Idéogrammes han — atteints seulement si ni kana ni hangul n'ont tranché.
  { lang: "zh", pattern: /[一-鿿㐀-䶿]/gu },
  { lang: "el", pattern: /[Ͱ-Ͽἀ-῿]/gu },
  { lang: "he", pattern: /[֐-׿]/gu },
  { lang: "ar", pattern: /[؀-ۿݐ-ݿ]/gu },
];

/**
 * Mots-outils par langue : articles, prépositions, conjonctions, auxiliaires,
 * pronoms. Ils sont choisis parce qu'ils reviennent quelle que soit la matière
 * du document — un texte technique, juridique ou commercial les contient tous
 * autant, là où les mots de contenu varient avec le sujet.
 *
 * Les formes élidées comptent comme des tokens à part entière (`l`, `d`, `qu`
 * en français, `dell`, `nell` en italien) : la tokenisation coupe sur
 * l'apostrophe, et ces fragments sont très discriminants.
 */
const FUNCTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: [
    "the", "of", "and", "to", "in", "that", "is", "was", "for", "with", "as", "on", "are", "be", "this",
    "have", "from", "or", "by", "an", "a", "it", "at", "not", "but", "which", "we", "you", "they", "has",
    "been", "will", "would", "there", "their", "what", "when", "can", "all", "if", "into", "than", "its",
    "should", "these", "he", "she", "our", "each", "any", "may",
  ],
  fr: [
    "le", "la", "les", "des", "du", "de", "un", "une", "et", "en", "dans", "pour", "est", "sont", "avec",
    "sur", "par", "que", "qui", "ne", "pas", "plus", "cette", "ces", "aux", "au", "être", "nous", "vous",
    "leur", "mais", "comme", "tout", "entre", "se", "son", "ses", "elle", "il", "ils", "elles", "sa",
    "d", "l", "qu", "j", "n", "c", "s", "ou", "ont", "été",
  ],
  es: [
    "el", "la", "los", "las", "de", "del", "y", "en", "que", "es", "un", "una", "por", "para", "con", "no",
    "se", "su", "sus", "como", "más", "pero", "este", "esta", "sobre", "entre", "cuando", "todo", "al",
    "lo", "ha", "han", "son", "está", "ser", "hay", "muy", "también", "desde", "sin", "hasta", "cada",
    "o", "a", "e", "nos", "les", "otro",
  ],
  pt: [
    "o", "a", "os", "as", "de", "do", "da", "dos", "das", "e", "em", "que", "é", "um", "uma", "por", "para",
    "com", "não", "se", "seu", "sua", "como", "mais", "mas", "este", "esta", "sobre", "entre", "quando",
    "ao", "à", "são", "ser", "há", "muito", "também", "desde", "sem", "até", "no", "na", "nos", "nas",
    "pelo", "pela", "isso", "ou", "foi",
  ],
  it: [
    "il", "lo", "la", "i", "gli", "le", "di", "del", "della", "e", "che", "è", "un", "una", "per", "con",
    "non", "si", "come", "più", "ma", "questo", "questa", "tra", "quando", "tutto", "alla", "sono",
    "essere", "ha", "anche", "da", "nel", "nella", "sul", "se", "ci", "loro", "dei", "delle", "in", "a",
    "al", "dall", "dell", "nell", "all", "o",
  ],
  de: [
    "der", "die", "das", "und", "den", "von", "zu", "mit", "sich", "des", "auf", "für", "ist", "im", "dem",
    "nicht", "ein", "eine", "als", "auch", "es", "an", "werden", "aus", "er", "hat", "dass", "sie", "nach",
    "wird", "bei", "einer", "um", "sind", "noch", "wie", "einem", "über", "so", "durch", "oder", "kann",
    "zur", "zum", "war", "man", "wenn",
  ],
  nl: [
    "de", "het", "een", "en", "van", "in", "is", "dat", "op", "te", "met", "voor", "niet", "aan", "er",
    "om", "ook", "als", "maar", "door", "over", "bij", "uit", "dan", "zijn", "worden", "wordt", "hebben",
    "heeft", "deze", "dit", "naar", "tot", "of", "nog", "wat", "waar", "hun", "ze", "wij", "kunnen",
    "moet", "geen", "welke", "onze", "was", "werd",
  ],
  pl: [
    "i", "w", "na", "do", "nie", "że", "to", "się", "z", "jest", "o", "a", "jak", "dla", "po", "ale",
    "przez", "przy", "tym", "tego", "który", "która", "które", "są", "być", "ma", "oraz", "lub", "tylko",
    "gdy", "już", "może", "bardzo", "można", "jeszcze", "między", "także", "wszystko", "jego", "jej",
    "od", "za", "co", "był", "była", "nas",
  ],
  cs: [
    "a", "v", "na", "se", "je", "že", "s", "do", "to", "z", "ve", "pro", "jako", "ale", "po", "při",
    "této", "který", "která", "které", "jsou", "být", "má", "nebo", "jen", "když", "už", "může", "velmi",
    "ještě", "mezi", "také", "vše", "jeho", "její", "od", "za", "tak", "si", "byl", "byla", "jsem",
    "i", "o", "u", "nejsou",
  ],
  sv: [
    "och", "att", "det", "som", "på", "är", "av", "för", "med", "till", "den", "om", "inte", "har", "de",
    "ett", "en", "men", "var", "från", "vi", "så", "kan", "man", "när", "ska", "eller", "vid", "efter",
    "under", "över", "alla", "andra", "sig", "sin", "deras", "mycket", "också", "bara", "vara", "detta",
    "sedan", "i", "han", "hon", "vara", "här",
  ],
  da: [
    "og", "at", "det", "som", "på", "er", "af", "for", "med", "til", "den", "om", "ikke", "har", "de",
    "et", "en", "men", "var", "fra", "vi", "så", "kan", "man", "når", "skal", "eller", "ved", "efter",
    "under", "over", "alle", "andre", "sig", "sin", "deres", "meget", "også", "kun", "være", "dette",
    "siden", "i", "han", "hun", "her",
  ],
  no: [
    "og", "at", "det", "som", "på", "er", "av", "for", "med", "til", "den", "om", "ikke", "har", "de",
    "et", "en", "men", "var", "fra", "vi", "så", "kan", "man", "når", "skal", "eller", "ved", "etter",
    "under", "over", "alle", "andre", "seg", "sin", "deres", "mye", "også", "bare", "være", "dette",
    "siden", "i", "han", "hun", "her",
  ],
  fi: [
    "ja", "on", "ei", "se", "että", "oli", "hän", "kuin", "mutta", "jos", "kun", "niin", "myös", "vain",
    "voi", "ovat", "olla", "tai", "sekä", "joka", "jotka", "tämä", "tässä", "siitä", "ole", "kaikki",
    "hyvin", "enemmän", "koska", "ennen", "jälkeen", "kanssa", "mukaan", "vielä", "aina", "nyt", "sitten",
    "myös", "ovat", "sen", "ne",
  ],
  ro: [
    "și", "de", "la", "în", "cu", "pe", "un", "o", "este", "sunt", "pentru", "care", "nu", "se", "ca",
    "mai", "dar", "din", "sau", "dacă", "când", "prin", "până", "între", "fost", "are", "fi", "foarte",
    "toate", "acest", "această", "său", "lor", "după", "fără", "doar", "deja", "așa", "tot", "ale",
    "cele", "a", "al", "ne",
  ],
  tr: [
    "ve", "bir", "bu", "için", "ile", "olarak", "çok", "daha", "en", "gibi", "kadar", "sonra", "önce",
    "ama", "veya", "her", "olan", "olduğu", "var", "yok", "değil", "ise", "ancak", "hem", "şu", "tüm",
    "üzere", "ayrıca", "hangi", "nasıl", "neden", "bazı", "birlikte", "üzerinde", "bunun", "de", "da",
    "ki", "o", "bize", "olarak",
  ],
  hu: [
    "a", "az", "és", "hogy", "nem", "is", "egy", "meg", "de", "van", "ez", "még", "csak", "már", "vagy",
    "mint", "majd", "volt", "lehet", "kell", "minden", "több", "ilyen", "olyan", "ami", "aki", "amely",
    "ezt", "között", "után", "előtt", "nélkül", "szerint", "illetve", "valamint", "sem", "sok", "így",
    "ha", "azt", "ben", "nak",
  ],
  ru: [
    "и", "в", "не", "на", "что", "с", "по", "это", "как", "к", "но", "они", "мы", "вы", "из", "у", "за",
    "от", "для", "то", "же", "был", "была", "были", "есть", "только", "еще", "уже", "или", "если",
    "когда", "все", "так", "бы", "при", "до", "его", "ее", "который", "которые", "может", "было", "а",
    "о", "их", "нас",
  ],
  uk: [
    "і", "в", "не", "на", "що", "з", "по", "це", "як", "до", "але", "вони", "ми", "ви", "із", "у", "за",
    "від", "для", "то", "ж", "був", "була", "були", "є", "тільки", "ще", "вже", "або", "якщо", "коли",
    "все", "так", "би", "при", "його", "її", "який", "які", "може", "було", "та", "й", "о", "їх", "нас",
  ],
};

/** Jeux figés une fois, au chargement du module : le détecteur tourne une fois
 *  par document et n'a pas à reconstruire dix-huit `Set` à chaque appel. */
export const FUNCTION_WORD_SETS: readonly { lang: string; words: ReadonlySet<string> }[] = Object.entries(
  FUNCTION_WORDS,
).map(([lang, words]) => ({ lang, words: new Set(words) }));
