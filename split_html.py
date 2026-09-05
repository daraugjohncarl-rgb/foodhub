import re

def main():
    with open('uploaded_customer.html', 'r', encoding='utf-8') as f:
        html_content = f.read()

    # Extract CSS
    style_match = re.search(r'<style>(.*?)</style>', html_content, re.DOTALL)
    if style_match:
        css_content = style_match.group(1)
        with open('fastapi/static/css/customer.css', 'w', encoding='utf-8') as f:
            f.write(css_content.strip())
        
        # Replace inline style with link tag
        html_content = re.sub(r'<style>.*?</style>', '<link rel="stylesheet" href="/static/css/customer.css">', html_content, flags=re.DOTALL)

    # Extract JS
    script_match = re.search(r'<script>(.*?)</script>', html_content, re.DOTALL)
    if script_match:
        js_content = script_match.group(1)
        with open('fastapi/static/js/dummy_new_customer.js', 'w', encoding='utf-8') as f:
            f.write(js_content.strip())
        
        # Replace inline script with our external script link
        html_content = re.sub(r'<script>.*?</script>', '<script src="/static/js/customer.js"></script>', html_content, flags=re.DOTALL)

    # Save cleaned HTML
    with open('fastapi/static/customer.html', 'w', encoding='utf-8') as f:
        f.write(html_content)

if __name__ == '__main__':
    main()
