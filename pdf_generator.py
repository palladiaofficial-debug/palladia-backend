from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
import sys
import json

def generate_pos_pdf(data, output_path):
    doc = SimpleDocTemplate(output_path, pagesize=A4, rightMargin=2*cm, leftMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()
    story = []
    
    # COPERTINA
    title_style = ParagraphStyle('CustomTitle', parent=styles['Heading1'], fontSize=24, textColor=colors.HexColor('#003366'), spaceAfter=30, alignment=TA_CENTER, fontName='Helvetica-Bold')
    
    story.append(Paragraph("PIANO OPERATIVO DI SICUREZZA", title_style))
    story.append(Paragraph("(Allegato XV, art. 89 e art. 96 del D.Lgs. 9 aprile 2008, n. 81 e s.m.i.)", styles['Normal']))
    story.append(Spacer(1, 40))
    
    # Box progetto
    project_data = [
        ['Oggetto:', data.get('address', 'N/A')],
        ['Tipo lavori:', data.get('workType', 'N/A')],
        ['Numero operai:', str(data.get('numWorkers', 0))],
        ['Data:', data.get('date', 'N/A')]
    ]
    
    project_table = Table(project_data, colWidths=[4*cm, 10*cm])
    project_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.grey),
        ('TEXTCOLOR', (0, 0), (0, -1), colors.whitesmoke),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('PADDING', (0, 0), (-1, -1), 12),
        ('BACKGROUND', (1, 0), (1, -1), colors.beige),
        ('GRID', (0, 0), (-1, -1), 1, colors.black)
    ]))
    story.append(project_table)
    story.append(PageBreak())
    
    # CONTENUTO AI
    story.append(Paragraph("CONTENUTO PIANO OPERATIVO DI SICUREZZA", styles['Heading1']))
    story.append(Spacer(1, 12))
    
    content = data.get('content', 'Contenuto non disponibile')
    for line in content.split('\n'):
        if line.strip():
            story.append(Paragraph(line, styles['Normal']))
            story.append(Spacer(1, 6))
    
    # Footer
    def add_footer(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.drawString(2*cm, 1*cm, "Documento generato con Palladia")
        canvas.drawRightString(A4[0] - 2*cm, 1*cm, f"Pagina {doc.page}")
        canvas.restoreState()
    
    doc.build(story, onFirstPage=add_footer, onLaterPages=add_footer)
    return output_path

if __name__ == "__main__":
    input_json = sys.argv[1]
    output_path = sys.argv[2]
    data = json.loads(input_json)
    generate_pos_pdf(data, output_path)
    print(output_path)