import os
import shutil
import datetime

def backup_files():
    base_dir = r"c:\GOOGLE_AI_STUDIO_YOLO"
    backupFileName = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = os.path.join(base_dir, f"ui_backup_{backupFileName}")
    
    if not os.path.exists(backup_dir):
        os.makedirs(backup_dir)
        
    # Files to backup
    files = ["App.tsx", "index.html"]
    for f in files:
        src = os.path.join(base_dir, f)
        if os.path.exists(src):
            shutil.copy2(src, backup_dir)
            print(f"Backed up {f}")
            
    # Dirs to backup
    dirs = ["components"]
    for d in dirs:
        src = os.path.join(base_dir, d)
        if os.path.exists(src):
            dest = os.path.join(backup_dir, d)
            shutil.copytree(src, dest)
            print(f"Backed up {d}")

    print(f"All backups saved to {backup_dir}")

if __name__ == "__main__":
    backup_files()
