import os
import shutil

def copy_txt_files(source_dir, target_dir):
    # 1. 원본 폴더를 하나씩 탐색합니다 (하위 폴더 포함)
    for root, dirs, files in os.walk(source_dir):
        for file in files:
            # 2. 파일 확장자가 .txt인 것만 골라냅니다
            if file.endswith(".txt"):
                
                # 원본 파일의 전체 경로
                source_path = os.path.join(root, file)
                
                # 대상 폴더에서의 상대적인 위치 계산
                rel_path = os.path.relpath(root, source_dir)
                target_path_dir = os.path.join(target_dir, rel_path)
                
                # 3. 대상 폴더에 하위 폴더 구조가 없다면 만들어줍니다
                if not os.path.exists(target_path_dir):
                    os.makedirs(target_path_dir)
                
                # 4. 파일을 복사합니다
                shutil.copy2(source_path, os.path.join(target_path_dir, file))
                print(f"복사 완료: {file}")

copy_txt_files(r"D:\GOOGLE_AI_STUDIO_YOLO\datasets\이재연", r"D:\GOOGLE_AI_STUDIO_YOLO\datasets\이재연\copy_이재연")