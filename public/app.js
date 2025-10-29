document.addEventListener('DOMContentLoaded', () => {
    const fileUpload = document.getElementById('file-upload');
    const fileList = document.getElementById('file-list');
    const question = document.getElementById('question');
    const charCount = document.querySelector('.char-count');
    const searchBtn = document.getElementById('search-btn');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');
    const results = document.getElementById('results');

    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    const uploadedFiles = new Map();

    function updateSearchButtonState() {
        searchBtn.disabled = uploadedFiles.size === 0 || !question.value.trim();
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function showError(message) {
        error.textContent = message;
        error.classList.remove('hidden');
    }

    function hideError() {
        error.classList.add('hidden');
        error.textContent = '';
    }

    function addFileToList(file) {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <span>${file.name} (${formatFileSize(file.size)})</span>
            <span class="file-remove" data-name="${file.name}">×</span>
        `;
        fileList.appendChild(fileItem);
    }

    fileUpload.addEventListener('change', async (e) => {
        hideError();
        const files = Array.from(e.target.files || []);
        
        for (const file of files) {
            if (file.size > MAX_FILE_SIZE) {
                showError(`${file.name} exceeds the 5MB limit`);
                continue;
            }

            const fileExt = file.name.split('.').pop()?.toLowerCase();
            const allowedTypes = ['pdf', 'docx', 'txt', 'csv', 'pptx', 'xlsx'];
            
            if (!allowedTypes.includes(fileExt)) {
                showError(`${file.name}: Unsupported file type`);
                continue;
            }

            uploadedFiles.set(file.name, file);
            addFileToList(file);
        }

        fileUpload.value = ''; // Reset input
        updateSearchButtonState();
    });

    fileList.addEventListener('click', (e) => {
        if (e.target.classList.contains('file-remove')) {
            const fileName = e.target.dataset.name;
            uploadedFiles.delete(fileName);
            e.target.parentElement.remove();
            updateSearchButtonState();
        }
    });

    question.addEventListener('input', (e) => {
        const length = e.target.value.length;
        charCount.textContent = `${length} / 1000`;
        updateSearchButtonState();
    });

    searchBtn.addEventListener('click', async () => {
        hideError();
        loading.classList.remove('hidden');
        results.classList.add('hidden');
        searchBtn.disabled = true;

        try {
            const formData = new FormData();
            let fileCount = 0;

            for (const [name, file] of uploadedFiles.entries()) {
                formData.append(`files`, file);
                fileCount++;
            }

            if (fileCount === 0) {
                throw new Error('Please upload at least one document');
            }

            formData.append('question', question.value.trim());

            const response = await fetch('/search/documents', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to process request');
            }

            results.textContent = data.output;
            results.classList.remove('hidden');
        } catch (err) {
            showError(err.message);
        } finally {
            loading.classList.add('hidden');
            searchBtn.disabled = false;
        }
    });
});