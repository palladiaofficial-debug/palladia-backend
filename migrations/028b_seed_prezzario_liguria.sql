-- Seed: Prezzario Regione Liguria 2023
-- Fonte: Prezzario Regionale dei Lavori Pubblici — Regione Liguria (edizione 2023)
-- Prezzi in euro, IVA esclusa. Soggetti ad aggiornamento annuale.
-- ~150 voci nelle categorie principali dell'edilizia civile e opere pubbliche.

INSERT INTO prezzario_voci (regione, anno, codice, categoria, sottocategoria, descrizione, um, prezzo, costo_mat, costo_mdo, costo_noli) VALUES

-- ═══════════════════════════════════════════════════════════════════════════════
-- MANODOPERA — Tabella paga edilizia industria (Liguria 2023)
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'MDO.01', 'Manodopera', 'Operai edili', 'Operaio comune — costo orario oneri inclusi', 'h', 28.50, NULL, 28.50, NULL),
('liguria', 2023, 'MDO.02', 'Manodopera', 'Operai edili', 'Operaio qualificato — costo orario oneri inclusi', 'h', 33.20, NULL, 33.20, NULL),
('liguria', 2023, 'MDO.03', 'Manodopera', 'Operai edili', 'Operaio specializzato — costo orario oneri inclusi', 'h', 36.80, NULL, 36.80, NULL),
('liguria', 2023, 'MDO.04', 'Manodopera', 'Operai edili', 'Caposquadra — costo orario oneri inclusi', 'h', 39.50, NULL, 39.50, NULL),
('liguria', 2023, 'MDO.05', 'Manodopera', 'Conducenti', 'Operatore macchine movimento terra — costo orario oneri inclusi', 'h', 35.40, NULL, 35.40, NULL),
('liguria', 2023, 'MDO.06', 'Manodopera', 'Conducenti', 'Autista autocarro — costo orario oneri inclusi', 'h', 32.10, NULL, 32.10, NULL),
('liguria', 2023, 'MDO.07', 'Manodopera', 'Tecnici', 'Geometra/Tecnico di cantiere — costo orario oneri inclusi', 'h', 42.00, NULL, 42.00, NULL),

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEMOLIZIONI E RIMOZIONI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'D.01.010', 'Demolizioni', 'Demolizioni manuali', 'Demolizione di muratura in mattoni pieni o semipieni, a mano', 'm³', 52.40, 0, 52.40, 0),
('liguria', 2023, 'D.01.020', 'Demolizioni', 'Demolizioni manuali', 'Demolizione di muratura in blocchi di calcestruzzo o laterizi, a mano', 'm³', 48.60, 0, 48.60, 0),
('liguria', 2023, 'D.01.030', 'Demolizioni', 'Demolizioni meccanizzate', 'Demolizione di muratura con mezzo meccanico, incluso carico macerie', 'm³', 22.80, 0, 8.50, 14.30),
('liguria', 2023, 'D.01.040', 'Demolizioni', 'Demolizioni meccanizzate', 'Demolizione di solaio in latero-cemento, con mezzo meccanico', 'm²', 18.50, 0, 6.20, 12.30),
('liguria', 2023, 'D.01.050', 'Demolizioni', 'Demolizioni manuali', 'Rimozione di pavimento in ceramica o gres, incluso sottofondo', 'm²', 14.20, 0, 14.20, 0),
('liguria', 2023, 'D.01.060', 'Demolizioni', 'Demolizioni manuali', 'Rimozione di rivestimento in piastrelle, a mano', 'm²', 11.80, 0, 11.80, 0),
('liguria', 2023, 'D.01.070', 'Demolizioni', 'Demolizioni manuali', 'Rimozione di intonaco da muratura, a mano, spessore medio 2 cm', 'm²', 8.40, 0, 8.40, 0),
('liguria', 2023, 'D.01.080', 'Demolizioni', 'Demolizioni', 'Demolizione di massetto in cls, spessore 8-12 cm, con martello demolitore', 'm²', 12.60, 0, 5.80, 6.80),
('liguria', 2023, 'D.01.090', 'Demolizioni', 'Rimozioni', 'Rimozione di serramento in legno o metallo, inclusi controtelaio e stipiti', 'cad', 38.50, 0, 38.50, 0),
('liguria', 2023, 'D.01.100', 'Demolizioni', 'Rimozioni', 'Rimozione di copertura in tegole marsigliesi, incluso smontaggio e accatastamento', 'm²', 16.20, 0, 16.20, 0),
('liguria', 2023, 'D.01.110', 'Demolizioni', 'Rimozioni', 'Rimozione di guaina bituminosa da copertura piana', 'm²', 9.80, 0, 9.80, 0),
('liguria', 2023, 'D.02.010', 'Demolizioni', 'Trasporti', 'Trasporto macerie a rifiuto, distanza fino a 10 km — a volume', 'm³', 18.40, 0, 3.20, 15.20),
('liguria', 2023, 'D.02.020', 'Demolizioni', 'Trasporti', 'Conferimento a discarica autorizzata, incluso onere smaltimento rifiuti inerti', 't', 24.00, 24.00, 0, 0),

-- ═══════════════════════════════════════════════════════════════════════════════
-- SCAVI, REINTERRI E RIPORTI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'S.01.010', 'Scavi', 'Scavi a macchina', 'Scavo a sezione aperta in terreno di qualsiasi natura (esclusa roccia), con escavatore', 'm³', 6.80, 0, 1.20, 5.60),
('liguria', 2023, 'S.01.020', 'Scavi', 'Scavi a macchina', 'Scavo a sezione obbligata in terreno ordinario, profondità fino a 3 m, con armatura', 'm³', 18.40, 0, 5.60, 12.80),
('liguria', 2023, 'S.01.030', 'Scavi', 'Scavi a macchina', 'Scavo a sezione obbligata in terreno ordinario, profondità 3-6 m', 'm³', 24.60, 0, 7.80, 16.80),
('liguria', 2023, 'S.01.040', 'Scavi', 'Scavi in roccia', 'Scavo in roccia compatta con martellone idraulico', 'm³', 38.50, 0, 8.40, 30.10),
('liguria', 2023, 'S.01.050', 'Scavi', 'Scavi a mano', 'Scavo a mano in terreno ordinario di qualsiasi consistenza', 'm³', 42.80, 0, 42.80, 0),
('liguria', 2023, 'S.01.060', 'Scavi', 'Scavi speciali', 'Scavo subacqueo o in presenza di acqua, in terreno ghiaioso-sabbioso', 'm³', 32.40, 0, 9.60, 22.80),
('liguria', 2023, 'S.02.010', 'Scavi', 'Reinterri', 'Rinterro con materiale proveniente da scavo, costipato a strati di 30 cm', 'm³', 9.20, 0, 4.80, 4.40),
('liguria', 2023, 'S.02.020', 'Scavi', 'Reinterri', 'Rinterro con tout-venant di cava, costipato con piastra vibrante', 'm³', 22.40, 16.80, 2.40, 3.20),
('liguria', 2023, 'S.02.030', 'Scavi', 'Reinterri', 'Rinterro con sabbia lavata, costipato', 'm³', 28.60, 22.00, 2.80, 3.80),
('liguria', 2023, 'S.03.010', 'Scavi', 'Riporti e livellamenti', 'Riporto e livellamento con terra vegetale, steso e profilato', 'm³', 24.80, 14.00, 5.60, 5.20),
('liguria', 2023, 'S.03.020', 'Scavi', 'Riporti e livellamenti', 'Formazione di rilevato con materiale selezionato, costipato a strati', 'm³', 16.40, 6.00, 4.20, 6.20),
('liguria', 2023, 'S.04.010', 'Scavi', 'Armature e sbadacchiature', 'Armatura di scavo con tavoloni in legno e puntellazioni metalliche, montaggio e smontaggio', 'm²', 18.60, 6.40, 8.20, 4.00),
('liguria', 2023, 'S.04.020', 'Scavi', 'Armature e sbadacchiature', 'Sbadacchiatura con pannelli metallici tipo Krings, noleggio + posa + smontaggio', 'm²', 14.80, 0, 4.20, 10.60),
('liguria', 2023, 'S.05.010', 'Scavi', 'Perforazioni e micropali', 'Esecuzione di micropalo ∅ 200 mm in terreno normale, incluso cls e armatura', 'ml', 68.50, 28.00, 18.50, 22.00),

-- ═══════════════════════════════════════════════════════════════════════════════
-- CALCESTRUZZI E STRUTTURE IN CLS ARMATO
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'C.01.010', 'Calcestruzzi', 'Fondazioni', 'CLS C16/20 per fondazioni a platea o plinti, fornito e posto in opera, incluso vibrazione', 'm³', 138.00, 98.00, 28.00, 12.00),
('liguria', 2023, 'C.01.020', 'Calcestruzzi', 'Fondazioni', 'CLS C20/25 per fondazioni, fornito e posto in opera', 'm³', 148.00, 106.00, 28.00, 14.00),
('liguria', 2023, 'C.01.030', 'Calcestruzzi', 'Strutture in elevazione', 'CLS C25/30 per strutture in elevazione (pilastri, travi, setti), fornito e posto in opera', 'm³', 168.00, 118.00, 32.00, 18.00),
('liguria', 2023, 'C.01.040', 'Calcestruzzi', 'Strutture in elevazione', 'CLS C28/35 per strutture in elevazione, fornito e posto in opera', 'm³', 182.00, 130.00, 32.00, 20.00),
('liguria', 2023, 'C.01.050', 'Calcestruzzi', 'Solai', 'CLS C25/30 per solai e balconi, getto di completamento, fornito e posto in opera', 'm³', 162.00, 114.00, 30.00, 18.00),
('liguria', 2023, 'C.01.060', 'Calcestruzzi', 'Magrone', 'Magrone di pulizia CLS C8/10, spessore 10 cm', 'm²', 12.80, 9.80, 2.00, 1.00),
('liguria', 2023, 'C.02.010', 'Calcestruzzi', 'Acciaio', 'Acciaio per c.a. B450C in barre, lavorato e posto in opera, incluso legatura', 'kg', 1.42, 0.88, 0.38, 0.16),
('liguria', 2023, 'C.02.020', 'Calcestruzzi', 'Acciaio', 'Rete elettrosaldata 6/150×150, posata su solaio o massetto', 'm²', 6.80, 4.20, 2.00, 0.60),
('liguria', 2023, 'C.03.010', 'Calcestruzzi', 'Casseformi', 'Cassaforma piana in legno per fondazioni e plinti, noleggio 30 gg + posa', 'm²', 24.60, 6.00, 12.80, 5.80),
('liguria', 2023, 'C.03.020', 'Calcestruzzi', 'Casseformi', 'Cassaforma modulare metallica per pilastri e setti, noleggio 30 gg + posa + disarmo', 'm²', 32.40, 0, 14.80, 17.60),
('liguria', 2023, 'C.04.010', 'Calcestruzzi', 'Solai misti', 'Solaio latero-cemento H 20+4 cm, incluso posa travetti, laterizi, getto, rete', 'm²', 62.00, 36.00, 18.00, 8.00),
('liguria', 2023, 'C.04.020', 'Calcestruzzi', 'Solai misti', 'Solaio latero-cemento H 24+4 cm', 'm²', 72.00, 44.00, 18.00, 10.00),

-- ═══════════════════════════════════════════════════════════════════════════════
-- OPERE MURARIE
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'M.01.010', 'Murature', 'Murature portanti', 'Muratura in mattoni semipieni 12×25×12 cm, malta di cemento, sp. 25 cm', 'm²', 62.40, 28.00, 32.00, 2.40),
('liguria', 2023, 'M.01.020', 'Murature', 'Murature portanti', 'Muratura in blocchi di cls vibrato sp. 20 cm, malta di cemento', 'm²', 44.80, 16.80, 26.00, 2.00),
('liguria', 2023, 'M.01.030', 'Murature', 'Murature portanti', 'Muratura in blocchi di cls vibrato sp. 30 cm, malta di cemento', 'm²', 58.60, 22.00, 34.00, 2.60),
('liguria', 2023, 'M.01.040', 'Murature', 'Murature di tamponamento', 'Muratura in laterizio sp. 8 cm (tramezza), malta di cemento', 'm²', 28.40, 10.80, 16.00, 1.60),
('liguria', 2023, 'M.01.050', 'Murature', 'Murature di tamponamento', 'Muratura in blocco forato (2T) sp. 20 cm, malta di cemento', 'm²', 38.20, 14.00, 22.00, 2.20),
('liguria', 2023, 'M.01.060', 'Murature', 'Murature di tamponamento', 'Muratura in blocco termico sp. 25 cm (Ytong o similare), colla speciale', 'm²', 52.80, 26.00, 24.80, 2.00),
('liguria', 2023, 'M.01.070', 'Murature', 'Murature di tamponamento', 'Muratura in blocco termico sp. 36 cm (Ytong o similare), colla speciale', 'm²', 68.40, 36.00, 28.40, 4.00),
('liguria', 2023, 'M.02.010', 'Murature', 'Massetti', 'Massetto in cls alleggerito sp. 8 cm, su solaio, con rete', 'm²', 24.80, 14.80, 8.00, 2.00),
('liguria', 2023, 'M.02.020', 'Murature', 'Massetti', 'Massetto autolivellante anidritico sp. 5 cm, su solaio', 'm²', 18.40, 12.00, 4.80, 1.60),
('liguria', 2023, 'M.02.030', 'Murature', 'Massetti', 'Massetto di sabbia e cemento sp. 6 cm, per pavimento riscaldante', 'm²', 16.80, 8.80, 6.00, 2.00),

-- ═══════════════════════════════════════════════════════════════════════════════
-- INTONACI E FINITURE ESTERNE
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'I.01.010', 'Intonaci', 'Intonaci interni', 'Intonaco civile rustico + finito, spessore medio 2 cm, su muratura', 'm²', 22.40, 5.60, 16.00, 0.80),
('liguria', 2023, 'I.01.020', 'Intonaci', 'Intonaci interni', 'Intonaco premiscelato tipo Rofix o similare, sp. 2 cm, compresi frattazzo e lisciatura', 'm²', 18.80, 6.80, 11.20, 0.80),
('liguria', 2023, 'I.01.030', 'Intonaci', 'Intonaci interni', 'Rasatura con gesso da costruzione, sp. 3-5 mm, per tinteggiatura', 'm²', 9.60, 3.20, 6.00, 0.40),
('liguria', 2023, 'I.01.040', 'Intonaci', 'Intonaci esterni', 'Intonaco a base di calce e cemento, esterno, sp. 2 cm', 'm²', 28.60, 7.60, 19.20, 1.80),
('liguria', 2023, 'I.01.050', 'Intonaci', 'Cappotti', 'Sistema a cappotto EPS sp. 8 cm, incluso rasante + tasselli + rete + finitura', 'm²', 78.00, 38.00, 34.00, 6.00),
('liguria', 2023, 'I.01.060', 'Intonaci', 'Cappotti', 'Sistema a cappotto EPS sp. 10 cm', 'm²', 86.00, 44.00, 36.00, 6.00),
('liguria', 2023, 'I.01.070', 'Intonaci', 'Cappotti', 'Sistema a cappotto EPS sp. 12 cm', 'm²', 94.00, 50.00, 38.00, 6.00),
('liguria', 2023, 'I.02.010', 'Intonaci', 'Tinteggiature', 'Tinteggiatura lavabile con pittura acrilica, due mani, su intonaco civile', 'm²', 7.80, 2.40, 5.00, 0.40),
('liguria', 2023, 'I.02.020', 'Intonaci', 'Tinteggiature', 'Pittura traspirante per esterni al quarzo, due mani', 'm²', 12.60, 4.80, 7.00, 0.80),

-- ═══════════════════════════════════════════════════════════════════════════════
-- PAVIMENTAZIONI E RIVESTIMENTI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'P.01.010', 'Pavimentazioni', 'Ceramica e gres', 'Posa di pavimento in ceramica fino a 30×30 cm, colla + stucco + livellamento', 'm²', 28.40, 4.80, 22.40, 1.20),
('liguria', 2023, 'P.01.020', 'Pavimentazioni', 'Ceramica e gres', 'Posa di pavimento in gres porcellanato fino a 60×60 cm, colla epossidica + stuccatura', 'm²', 34.80, 6.80, 26.40, 1.60),
('liguria', 2023, 'P.01.030', 'Pavimentazioni', 'Ceramica e gres', 'Posa di pavimento in gres porcellanato formato maxi (60×120 cm e oltre)', 'm²', 48.40, 8.40, 38.00, 2.00),
('liguria', 2023, 'P.01.040', 'Pavimentazioni', 'Marmo e pietra', 'Posa di pavimento in marmo/pietra sp. 2 cm, colla e stuccatura', 'm²', 42.60, 8.00, 32.40, 2.20),
('liguria', 2023, 'P.01.050', 'Pavimentazioni', 'Parquet', 'Posa di parquet prefinito sp. 10 mm, su massetto, incluso battiscopa', 'm²', 22.80, 4.00, 17.60, 1.20),
('liguria', 2023, 'P.02.010', 'Pavimentazioni', 'Rivestimenti', 'Posa di rivestimento murale in ceramica fino a 20×20 cm, colla + stucco', 'm²', 30.20, 5.20, 23.80, 1.20),
('liguria', 2023, 'P.02.020', 'Pavimentazioni', 'Rivestimenti', 'Posa di rivestimento murale in gres fino a 30×60 cm, colla + stucco', 'm²', 38.40, 7.00, 29.40, 2.00),
('liguria', 2023, 'P.03.010', 'Pavimentazioni', 'Impermeabilizzazione sotto pavimento', 'Guaina liquida poliuretanica su massetto bagno, 2 mani, incluso primer', 'm²', 22.60, 12.00, 9.60, 1.00),

-- ═══════════════════════════════════════════════════════════════════════════════
-- COPERTURE E IMPERMEABILIZZAZIONI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'K.01.010', 'Coperture', 'Tetti a falde', 'Copertura con tegole marsigliesi in laterizio, incluso listelli, sottotegola, colmo', 'm²', 68.00, 32.00, 30.00, 6.00),
('liguria', 2023, 'K.01.020', 'Coperture', 'Tetti a falde', 'Copertura con coppi in laterizio, incluso listelli, feltro, colmo in cotto', 'm²', 84.00, 44.00, 34.00, 6.00),
('liguria', 2023, 'K.01.030', 'Coperture', 'Tetti a falde', 'Sostituzione di singola tegola marsigliese danneggiata, incluso rimozione', 'cad', 12.80, 4.80, 8.00, 0),
('liguria', 2023, 'K.02.010', 'Coperture', 'Impermeabilizzazioni', 'Impermeabilizzazione con guaina bituminosa armata 4 kg/m², a fiamma, su cls', 'm²', 28.40, 14.00, 13.20, 1.20),
('liguria', 2023, 'K.02.020', 'Coperture', 'Impermeabilizzazioni', 'Impermeabilizzazione con doppia guaina bituminosa (2×4 kg/m²), a fiamma', 'm²', 46.80, 24.00, 20.80, 2.00),
('liguria', 2023, 'K.02.030', 'Coperture', 'Impermeabilizzazioni', 'Membrana impermeabilizzante liquida poliureica sp. 2 mm, a pennello, incluso primer', 'm²', 38.60, 22.00, 15.60, 1.00),
('liguria', 2023, 'K.02.040', 'Coperture', 'Isolamento termico', 'Pannello in lana di roccia sp. 8 cm su copertura, posato a secco', 'm²', 32.40, 20.00, 11.40, 1.00),
('liguria', 2023, 'K.02.050', 'Coperture', 'Isolamento termico', 'Pannello in lana di roccia sp. 10 cm su copertura', 'm²', 38.80, 24.80, 12.00, 2.00),
('liguria', 2023, 'K.03.010', 'Coperture', 'Gronde e pluviali', 'Gronda in rame sp. 0,60 mm, sviluppo 33 cm, incluso graffe e sigillatura', 'ml', 38.50, 18.00, 19.00, 1.50),
('liguria', 2023, 'K.03.020', 'Coperture', 'Gronde e pluviali', 'Pluviale in rame ∅ 100 mm, incluso graffe, collari, scarico a muro', 'ml', 42.80, 20.00, 21.00, 1.80),

-- ═══════════════════════════════════════════════════════════════════════════════
-- SERRAMENTI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'SER.01.010', 'Serramenti', 'Finestre', 'Finestra in PVC a battente 2 ante 120×140 cm, doppio vetro basso emissivo, incluso posa', 'cad', 680.00, 540.00, 140.00, 0),
('liguria', 2023, 'SER.01.020', 'Serramenti', 'Finestre', 'Finestra in alluminio a taglio termico 2 ante 120×140 cm, doppio vetro, incluso posa', 'cad', 980.00, 800.00, 180.00, 0),
('liguria', 2023, 'SER.01.030', 'Serramenti', 'Finestre', 'Finestra in legno massello verniciato 2 ante 120×140 cm, doppio vetro', 'cad', 1240.00, 1020.00, 220.00, 0),
('liguria', 2023, 'SER.01.040', 'Serramenti', 'Porte', 'Porta interna tamburata, pre-laccata bianca 80×210 cm, incluso telaio e maniglie', 'cad', 420.00, 320.00, 100.00, 0),
('liguria', 2023, 'SER.01.050', 'Serramenti', 'Porte', 'Porta blindata REI 30 80×210 cm, incluso controtelaio, posa e sigillatura', 'cad', 1280.00, 1060.00, 220.00, 0),
('liguria', 2023, 'SER.01.060', 'Serramenti', 'Avvolgibili', 'Avvolgibile in alluminio 120×140 cm, motore elettrico, comando radio', 'cad', 620.00, 480.00, 140.00, 0),
('liguria', 2023, 'SER.01.070', 'Serramenti', 'Portoni', 'Portone garage basculante a soffitto 250×230 cm, acciaio, apertura elettrica', 'cad', 2200.00, 1760.00, 440.00, 0),

-- ═══════════════════════════════════════════════════════════════════════════════
-- PONTEGGI E OPERE PROVVISIONALI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'PON.01.010', 'Ponteggi', 'Ponteggio tubolare', 'Ponteggio tubolare fisso tipo Innocenti, montaggio + noleggio mensile + smontaggio (quota mensile)', 'm²/mese', 4.80, 0, 1.60, 3.20),
('liguria', 2023, 'PON.01.020', 'Ponteggi', 'Ponteggio tubolare', 'Ponteggio tubolare fisso, solo montaggio e smontaggio (una tantum)', 'm²', 8.40, 0, 5.20, 3.20),
('liguria', 2023, 'PON.01.030', 'Ponteggi', 'Ponteggio a telai', 'Ponteggio a telai prefabbricati tipo Lev, montaggio + noleggio mensile + smontaggio', 'm²/mese', 3.80, 0, 1.20, 2.60),
('liguria', 2023, 'PON.02.010', 'Ponteggi', 'Trabattello', 'Trabattello su ruote H fino a 6 m, noleggio al giorno incluso montaggio', 'cad/gg', 38.00, 0, 8.00, 30.00),
('liguria', 2023, 'PON.02.020', 'Ponteggi', 'Scale', 'Scala telescopica da cantiere in alluminio fino 10 m, noleggio al giorno', 'cad/gg', 12.00, 0, 2.00, 10.00),
('liguria', 2023, 'PON.03.010', 'Ponteggi', 'Protezioni', 'Telo di protezione in polipropilene verde, posa + rimozione inclusa', 'm²', 4.20, 2.00, 2.00, 0.20),
('liguria', 2023, 'PON.03.020', 'Ponteggi', 'Protezioni', 'Rete anticaduta UNI EN 1263, posa + controllo + rimozione', 'm²', 6.80, 2.80, 3.60, 0.40),
('liguria', 2023, 'PON.03.030', 'Ponteggi', 'Protezioni', 'Parapetto perimetrale in tubi e tavole, montaggio e smontaggio', 'ml', 14.60, 3.60, 8.80, 2.20),

-- ═══════════════════════════════════════════════════════════════════════════════
-- STRADE, PIAZZE E PAVIMENTAZIONI ESTERNE
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'ST.01.010', 'Strade', 'Fresatura', 'Fresatura di manto bituminoso sp. 4 cm con fresatrice meccanica, incluso carico', 'm²', 6.20, 0, 0.80, 5.40),
('liguria', 2023, 'ST.01.020', 'Strade', 'Binder', 'Strato di binder sp. 5 cm, bitume modificato, incluso trasporto e compattazione', 'm²', 12.80, 7.80, 1.60, 3.40),
('liguria', 2023, 'ST.01.030', 'Strade', 'Tappeto', 'Tappeto di usura sp. 3 cm, bitume modificato, incluso compattazione', 'm²', 9.60, 5.80, 1.40, 2.40),
('liguria', 2023, 'ST.01.040', 'Strade', 'Manti completi', 'Manto bituminoso completo (fondazione 15 cm + binder 6 cm + usura 3 cm)', 'm²', 48.60, 28.00, 8.00, 12.60),
('liguria', 2023, 'ST.02.010', 'Strade', 'Cordoli e marciapiedi', 'Cordolo in granito grigio 12×25 cm, posato su cls, incluso scavo e reinterro', 'ml', 42.80, 18.00, 22.80, 2.00),
('liguria', 2023, 'ST.02.020', 'Strade', 'Cordoli e marciapiedi', 'Cordolo prefabbricato in cls vibrocompresso 15×25 cm, posato su letto di cls', 'ml', 28.40, 12.00, 14.40, 2.00),
('liguria', 2023, 'ST.02.030', 'Strade', 'Cordoli e marciapiedi', 'Marciapiede in porfido sp. 4 cm, su sabbia, incluso stesa sabbia e sigillatura', 'm²', 58.00, 32.00, 24.00, 2.00),
('liguria', 2023, 'ST.02.040', 'Strade', 'Cordoli e marciapiedi', 'Pavimentazione esterna in cubetti di porfido 6×6 cm, su sabbia e letto di cls', 'm²', 72.00, 40.00, 28.00, 4.00),
('liguria', 2023, 'ST.03.010', 'Strade', 'Segnaletica', 'Segnaletica orizzontale in vernice rifrangente bianca, passaggio pedonale', 'm²', 14.60, 6.00, 7.20, 1.40),
('liguria', 2023, 'ST.03.020', 'Strade', 'Segnaletica', 'Segnaletica orizzontale, strisce di corsia ml 50 (largh. 12 cm)', 'ml', 1.80, 0.60, 0.90, 0.30),

-- ═══════════════════════════════════════════════════════════════════════════════
-- OPERE DI FOGNATURA E RETI IDRICHE
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'F.01.010', 'Fognature', 'Tubazioni in PVC', 'Tubazione in PVC per fognatura SN4 ∅ 200 mm, posata e conglobata', 'ml', 38.40, 18.00, 14.40, 6.00),
('liguria', 2023, 'F.01.020', 'Fognature', 'Tubazioni in PVC', 'Tubazione in PVC per fognatura SN4 ∅ 300 mm, posata e conglobata', 'ml', 56.80, 28.00, 20.00, 8.80),
('liguria', 2023, 'F.01.030', 'Fognature', 'Tubazioni in PVC', 'Tubazione in PVC per fognatura SN8 ∅ 400 mm, posata e conglobata', 'ml', 84.00, 44.00, 28.00, 12.00),
('liguria', 2023, 'F.02.010', 'Fognature', 'Pozzetti', 'Pozzetto di ispezione in cls prefabbricato 50×50 cm, prof. 1 m, incluso scavo', 'cad', 380.00, 160.00, 180.00, 40.00),
('liguria', 2023, 'F.02.020', 'Fognature', 'Pozzetti', 'Pozzetto sifone in PE prefabbricato 315 mm, incluso posa e connessioni', 'cad', 280.00, 180.00, 80.00, 20.00),
('liguria', 2023, 'F.03.010', 'Fognature', 'Reti idriche', 'Tubazione in PEAD PE100 PN10 ∅ 63 mm per acqua potabile, posata in trincea', 'ml', 22.40, 8.80, 10.40, 3.20),
('liguria', 2023, 'F.03.020', 'Fognature', 'Reti idriche', 'Tubazione in PEAD PE100 PN10 ∅ 110 mm per acqua potabile', 'ml', 34.60, 14.00, 14.80, 5.80),
('liguria', 2023, 'F.04.010', 'Fognature', 'Noleggi', 'Noleggio pompa di aggottamento 4" con 50 m di tubo flessibile, al giorno', 'cad/gg', 68.00, 0, 8.00, 60.00),

-- ═══════════════════════════════════════════════════════════════════════════════
-- IMPIANTI ELETTRICI (principali voci a corpo)
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'E.01.010', 'Impianti elettrici', 'Canaline e tubazioni', 'Tubazione corrugata flessibile ∅ 20 mm sotto intonaco, incluso posa e fissaggi', 'ml', 4.20, 0.80, 3.20, 0.20),
('liguria', 2023, 'E.01.020', 'Impianti elettrici', 'Canaline e tubazioni', 'Tubazione rigida in PVC ∅ 25 mm a vista, incluso staffe e curve', 'ml', 6.40, 1.60, 4.40, 0.40),
('liguria', 2023, 'E.01.030', 'Impianti elettrici', 'Cavi', 'Posa di cavo FG16OR16 3G1,5 mm², incluso tiro e connessione (prezzo al metro lineare)', 'ml', 3.80, 0.80, 2.80, 0.20),
('liguria', 2023, 'E.01.040', 'Impianti elettrici', 'Cavi', 'Posa di cavo FG16OR16 3G2,5 mm²', 'ml', 4.60, 1.20, 3.20, 0.20),
('liguria', 2023, 'E.02.010', 'Impianti elettrici', 'Frutti e placche', 'Punto luce interruttore semplice, incluso frutto, placca, scatola, collegamento', 'cad', 48.00, 18.00, 28.00, 2.00),
('liguria', 2023, 'E.02.020', 'Impianti elettrici', 'Frutti e placche', 'Presa di corrente 16A 2P+T, incluso frutto, placca, scatola, collegamento', 'cad', 42.00, 16.00, 24.00, 2.00),
('liguria', 2023, 'E.02.030', 'Impianti elettrici', 'Frutti e placche', 'Presa TV+SAT passante, incluso derivatore e collegamento', 'cad', 68.00, 32.00, 34.00, 2.00),
('liguria', 2023, 'E.03.010', 'Impianti elettrici', 'Quadri', 'Quadro elettrico da incasso 18 moduli, incluso DPN, interruttori differenziali, posa', 'cad', 380.00, 220.00, 160.00, 0),

-- ═══════════════════════════════════════════════════════════════════════════════
-- IMPIANTI IDRAULICI E SANITARI
-- ═══════════════════════════════════════════════════════════════════════════════
('liguria', 2023, 'H.01.010', 'Impianti idraulici', 'Tubazioni', 'Tubazione multistrato ∅ 20 mm sotto traccia, incluso posa, fissaggi, raccordi', 'ml', 18.40, 6.80, 10.40, 1.20),
('liguria', 2023, 'H.01.020', 'Impianti idraulici', 'Tubazioni', 'Tubazione multistrato ∅ 32 mm, posata a vista o sotto traccia', 'ml', 26.80, 10.80, 14.00, 2.00),
('liguria', 2023, 'H.02.010', 'Impianti idraulici', 'Sanitari', 'Fornitura e posa vaso WC sospeso con cassetta a zaino, incluso sedile, flussometro', 'cad', 520.00, 320.00, 200.00, 0),
('liguria', 2023, 'H.02.020', 'Impianti idraulici', 'Sanitari', 'Fornitura e posa lavabo da appoggio 60 cm, incluso sifone, rubinetteria, collegamento', 'cad', 480.00, 280.00, 200.00, 0),
('liguria', 2023, 'H.02.030', 'Impianti idraulici', 'Sanitari', 'Fornitura e posa piatto doccia 80×80 cm in ceramica, incluso piletta e scarico', 'cad', 320.00, 180.00, 140.00, 0),
('liguria', 2023, 'H.03.010', 'Impianti idraulici', 'Riscaldamento', 'Radiatore in alluminio 10 elementi H 600 mm, incluso valvola e detentore, posa', 'cad', 280.00, 160.00, 120.00, 0),
('liguria', 2023, 'H.03.020', 'Impianti idraulici', 'Riscaldamento', 'Tubazione riscaldamento multistrato ∅ 20 mm, incluso isolamento, posa a pavimento', 'ml', 22.60, 8.00, 13.40, 1.20);
