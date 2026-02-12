import os
import sys
import json
import comtypes.client

def convert_ppt_to_pdf(input_path, output_path):
    """
    Converts a PowerPoint file to PDF using Windows COM interface.
    """
    input_path = os.path.abspath(input_path)
    output_path = os.path.abspath(output_path)

    if not os.path.exists(input_path):
        print(f"Error: Input file not found at {input_path}")
        return False

    print(f"Converting {os.path.basename(input_path)}...")

    powerpoint = None
    presentation = None

    try:
        powerpoint = comtypes.client.CreateObject("Powerpoint.Application")
        # powerpoint.Visible = 1 # Optional: make it visible for debugging

        # Ensure absolute path with extended prefix for Windows long paths if needed,
        # though standard abspath usually works.
        input_path = os.path.abspath(input_path)
        
        presentation = powerpoint.Presentations.Open(input_path, WithWindow=False)
        
        # 32 is the format type for PDF (ppSaveAsPDF)
        presentation.SaveAs(output_path, 32)
        print(f"  -> Success: {os.path.basename(output_path)}")
        return True

    except Exception as e:
        error_msg = str(e)
        if "Invalid class string" in error_msg or "-2147221005" in error_msg:
            print(f"  -> Error: Microsoft PowerPoint is not installed or not registered.")
            print(f"     (This script requires PowerPoint to be installed on the machine running it)")
        else:
            print(f"Error during conversion of {os.path.basename(input_path)}: {e}")
        return False

    finally:
        if presentation:
            try:
                presentation.Close()
            except:
                pass
        if powerpoint:
            try:
                powerpoint.Quit()
            except:
                pass

if __name__ == "__main__":
    current_dir = os.getcwd()
    
    # Define source and target paths
    source_dir = os.path.join(current_dir, "guide_source")
    target_dir = os.path.join(current_dir, "public", "guides")

    # Ensure directories exist
    if not os.path.exists(source_dir):
        os.makedirs(source_dir)
        print(f"Created source directory: {source_dir}")
        print("Please place your PPTX files in this folder.")
        sys.exit(0)

    os.makedirs(target_dir, exist_ok=True)

    # Process all PPTX files
    ppt_files = [f for f in os.listdir(source_dir) if f.lower().endswith(('.pptx', '.ppt'))]
    
    if not ppt_files:
        print(f"No PowerPoint files found in {source_dir}")
        print("Please place your .pptx files there and run this script again.")
        sys.exit(0)

    print(f"Found {len(ppt_files)} PowerPoint files.")
    
    guide_list = []

    for filename in ppt_files:
        name_without_ext = os.path.splitext(filename)[0]
        pdf_filename = f"{name_without_ext}.pdf"
        
        source_file = os.path.join(source_dir, filename)
        target_file = os.path.join(target_dir, pdf_filename)
        
        # Check if conversion is needed
        should_convert = True
        if os.path.exists(target_file):
            src_mtime = os.path.getmtime(source_file)
            tgt_mtime = os.path.getmtime(target_file)
            if tgt_mtime > src_mtime:
                print(f"Skipping {filename} (PDF is up to date)")
                should_convert = False
        
        # Convert
        success = True
        if should_convert:
            success = convert_ppt_to_pdf(source_file, target_file)
        
        if success:
            guide_list.append({
                "title": name_without_ext,
                "filename": pdf_filename
            })

    # Generate list.json
    list_file = os.path.join(target_dir, "list.json")
    with open(list_file, 'w', encoding='utf-8') as f:
        json.dump(guide_list, f, ensure_ascii=False, indent=2)

    print("-" * 50)
    print(f"Update complete!")
    print(f"Converted {len(guide_list)} files.")
    print(f"Guide list saved to: {list_file}")
    print("-" * 50)
